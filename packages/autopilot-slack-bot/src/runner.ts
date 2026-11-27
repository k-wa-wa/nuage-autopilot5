import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  formatInvocation,
  getAgentAdapter,
  type Invocation,
  type SessionRequest,
} from "../../autopilot-run/src/agents.ts";
import { capture, killAll, run } from "../../autopilot-run/src/exec.ts";
import { loadModelTable, MODELS_PATH, resolveTaskChain } from "../../autopilot-run/src/models.ts";
import { resolveStateDir, tryAcquireLock } from "../../autopilot-task/src/lock.ts";
import { resolveSlackRuntimeEnv, type SlackBotConfig } from "./config.ts";
import { buildSlackPrompt, type SlackThreadMessage, splitSlackMessage } from "./prompt.ts";
import { ThreadQueue } from "./queue.ts";
import { type BotIdentity, EventRouter, type RouteDecision, type SlackEvent } from "./router.ts";
import { SlackWebClient, SocketModeClient } from "./slack.ts";
import { type ThreadSessionState, ThreadSessionStore, threadKey } from "./state.ts";

function appendLog(logPath: string, prefix: string, msg: string): void {
  const time = new Date().toISOString();
  appendFileSync(logPath, `[${time}] ${prefix}${msg}\n`);
}

function hashDirEntries(dir: string, relBase: string, hash: ReturnType<typeof createHash>): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const st = lstatSync(full);
    if (st.isDirectory()) {
      hash.update(`D:${rel}\0`);
      hashDirEntries(full, rel, hash);
    } else if (st.isFile()) {
      hash.update(`F:${rel}:${st.size}:${st.mtimeMs}\0`);
    } else {
      hash.update(`O:${rel}:${st.mode}\0`);
    }
  }
}

async function snapshotWorkdir(workdir: string): Promise<string> {
  const inside = await capture(
    ["git", "-C", workdir, "rev-parse", "--is-inside-work-tree"],
    workdir,
  );
  const hash = createHash("sha256");
  if (inside.code === 0 && inside.stdout === "true") {
    const parts = await Promise.all([
      capture(["git", "-C", workdir, "rev-parse", "HEAD"], workdir),
      capture(
        ["git", "-C", workdir, "status", "--porcelain=v1", "--untracked-files=all"],
        workdir,
        { trim: false },
      ),
      capture(["git", "-C", workdir, "diff", "HEAD"], workdir, { trim: false }),
    ]);
    for (const p of parts) hash.update(`${p.stdout}\0`);
  } else {
    hashDirEntries(workdir, "", hash);
  }
  return hash.digest("hex");
}

function sanitizeFileSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "turn";
}

function buildAgentEnvOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, undefined> {
  const overrides: Record<string, undefined> = {
    SLACK_BOT_TOKEN: undefined,
    SLACK_APP_TOKEN: undefined,
    SLACK_BOT_TOKEN_FILE: undefined,
    SLACK_APP_TOKEN_FILE: undefined,
  };
  for (const key of Object.keys(env)) {
    if (/^SLACK_.*_TOKEN(?:_FILE)?$/.test(key)) overrides[key] = undefined;
  }
  return overrides;
}

interface AgentExecutionSuccess {
  ok: true;
  inv: Invocation;
  sessionId: string | null;
  text: string;
}

interface AgentExecutionFailure {
  ok: false;
  timedOut: boolean;
  reason: string;
}

type AgentExecutionResult = AgentExecutionSuccess | AgentExecutionFailure;

export interface RunSlackBotOptions {
  config: SlackBotConfig;
  pingIntervalMs?: number;
  inactivityTimeoutMs?: number;
  helloTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  authRetryInitialMs?: number;
  authRetryMaxMs?: number;
}

/**
 * Slack Bot 常駐ランナーを起動し、Socket Mode でイベントを受けて調査・対応を行う。
 */
export async function runSlackBot(opts: RunSlackBotOptions): Promise<number> {
  const { config } = opts;
  const runtimeEnv = resolveSlackRuntimeEnv(config);

  const stateDir = resolveStateDir();
  const logPath = join(stateDir, "logs", `slack-bot-${config.name}.log`);
  const agentStdoutDir = join(stateDir, "logs", `slack-bot-${config.name}`);
  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(agentStdoutDir, { recursive: true });

  const log = (msg: string) => {
    console.log(`[autopilot-slack-bot:${config.name}] ${msg}`);
    appendLog(logPath, "", msg);
  };
  const warn = (msg: string) => {
    console.warn(`[autopilot-slack-bot:${config.name}] WARN: ${msg}`);
    appendLog(logPath, "WARN: ", msg);
  };
  const error = (msg: string) => {
    console.error(`[autopilot-slack-bot:${config.name}] ERROR: ${msg}`);
    appendLog(logPath, "ERROR: ", msg);
  };

  const botLockPath = join(stateDir, "locks", `slack-bot-${config.name}.lock`);
  const botLock = tryAcquireLock(botLockPath);
  if (!botLock.acquired) {
    error(`すでに実行中 (pid=${botLock.pid ?? "unknown"})`);
    return 1;
  }

  const workdir = config.workdir ?? join(stateDir, "workdirs", `slack-bot-${config.name}`);
  if (existsSync(workdir) && !statSync(workdir).isDirectory()) {
    error(`workdir がディレクトリではない: ${workdir}`);
    botLock.handle.release();
    return 1;
  }
  mkdirSync(workdir, { recursive: true });

  const slackClient = new SlackWebClient({
    apiBaseUrl: runtimeEnv.apiBaseUrl,
    botToken: runtimeEnv.botToken,
    appToken: runtimeEnv.appToken,
  });
  const sessionStore = new ThreadSessionStore(stateDir, config.name);
  const fallbackSessions = new Map<string, ThreadSessionState>();
  const router = new EventRouter();
  const queue = new ThreadQueue(config.concurrency);

  const shutdownController = new AbortController();
  let socketClient: SocketModeClient | null = null;

  const onSignal = (sig: NodeJS.Signals) => {
    log(`シグナル ${sig} を受信したため停止する`);
    shutdownController.abort();
    socketClient?.stop();
    killAll();
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const sig of signals) process.on(sig, onSignal);

  const postReply = async (channel: string, threadTs: string, text: string): Promise<boolean> => {
    const chunks = splitSlackMessage(text);
    const toSend = chunks.length > 0 ? chunks : ["(エージェントからの応答本文が空だった)"];
    try {
      for (const chunk of toSend) {
        await slackClient.postMessage({ channel, thread_ts: threadTs, text: chunk });
      }
      return true;
    } catch (e) {
      error(
        `chat.postMessage 失敗 (channel=${channel}, thread_ts=${threadTs}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  };

  const saveSessionSafely = (state: ThreadSessionState): void => {
    const k = threadKey(state.channel, state.threadTs);
    try {
      sessionStore.save(state);
      fallbackSessions.delete(k);
    } catch (saveErr) {
      fallbackSessions.set(k, state);
      error(
        `セッション状態の保存に失敗: key=${k} reason=${
          saveErr instanceof Error ? saveErr.message : String(saveErr)
        }`,
      );
    }
  };

  type ThreadHistoryFetchResult =
    | { ok: true; messages: SlackThreadMessage[]; error: null }
    | { ok: false; messages: null; error: string };

  const fetchThreadMessagesSafe = async (
    channel: string,
    threadTs: string,
  ): Promise<ThreadHistoryFetchResult> => {
    try {
      const messages = await slackClient.getThreadReplies(channel, threadTs);
      return { ok: true, messages, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`conversations.replies 失敗 (channel=${channel}, ts=${threadTs}): ${msg}`);
      return { ok: false, messages: null, error: msg };
    }
  };

  const runAgentChain = async (
    prompt: string,
    chain: Invocation[],
    deadline: number,
    turnId: string,
  ): Promise<AgentExecutionResult> => {
    for (const inv of chain) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          ok: false,
          timedOut: true,
          reason: `タイムアウト (${config.timeoutSec}s) した`,
        };
      }

      const beforeWorkdir = await snapshotWorkdir(workdir);
      const sessionReq: SessionRequest = { kind: "start", id: randomUUID() };
      const stdoutPath = join(agentStdoutDir, `${turnId}-${inv.agent}.log`);

      log(`-> ${formatInvocation(inv)} (新規セッション)`);
      const adapter = getAgentAdapter(inv.agent);
      const r = await run(adapter.buildArgv(inv, prompt, sessionReq), {
        cwd: workdir,
        logPath,
        stdoutPath,
        timeoutMs: remainingMs,
        env: buildAgentEnvOverrides(),
      });

      if (shutdownController.signal.aborted) {
        return {
          ok: false,
          timedOut: false,
          reason: "停止要求により中断した",
        };
      }

      if (r.timedOut) {
        return {
          ok: false,
          timedOut: true,
          reason: `${formatInvocation(inv)}: タイムアウト (${config.timeoutSec}s) した`,
        };
      }

      const out = adapter.readResult(r, sessionReq);
      if (out.text) {
        appendFileSync(logPath, out.text.endsWith("\n") ? out.text : `${out.text}\n`);
      }

      if (out.failure === null) {
        return {
          ok: true,
          inv,
          sessionId: out.session,
          text: out.text,
        };
      }

      if (out.failure === "unavailable") {
        const afterWorkdir = await snapshotWorkdir(workdir);
        if (afterWorkdir !== beforeWorkdir) {
          const reason = `${formatInvocation(inv)}: 作業ディレクトリを変更した後に利用不能 (exit ${r.code}) となったため別候補へ切り替えない`;
          error(reason);
          return { ok: false, timedOut: false, reason };
        }
        warn(`${formatInvocation(inv)}: 利用不能 (exit ${r.code}) のため次候補へ切り替える`);
        continue;
      }

      const reason = `${formatInvocation(inv)}: 異常終了 (exit ${r.code})`;
      error(reason);
      return { ok: false, timedOut: false, reason };
    }

    return {
      ok: false,
      timedOut: false,
      reason: "利用可能なエージェント候補がすべて失敗した",
    };
  };

  const handleDecision = async (decision: RouteDecision, identity: BotIdentity): Promise<void> => {
    const key = threadKey(decision.channel, decision.threadTs);
    const turnId = `${sanitizeFileSegment(decision.channel)}-${sanitizeFileSegment(decision.messageTs)}-${randomUUID().slice(0, 8)}`;
    const saved =
      sessionStore.get(decision.channel, decision.threadTs) ?? fallbackSessions.get(key) ?? null;
    let replyPosted = false;

    try {
      log(`スレッド処理開始: key=${key}, trigger=${decision.kind}, ts=${decision.messageTs}`);

      const soulText = readFileSync(config.soulFile, "utf8");
      const modelsPath = process.env.AUTOPILOT_MODELS || MODELS_PATH;
      const models = loadModelTable(modelsPath) ?? {};
      const chain = resolveTaskChain(config.agent, config.level, models);
      const botDisplayName = identity.userName ?? config.name;
      const deadline = Date.now() + config.timeoutSec * 1000;

      let result: AgentExecutionResult | null = null;

      if (saved?.agent && saved.sessionId) {
        const resumeInv: Invocation = {
          agent: saved.agent,
          ...(saved.model ? { model: saved.model } : {}),
          ...(saved.effort ? { effort: saved.effort } : {}),
        };
        const sessionReq: SessionRequest = { kind: "resume", id: saved.sessionId };
        const resumePrompt = buildSlackPrompt({
          config,
          botDisplayName,
          soulText,
          nowIso: new Date().toISOString(),
          workdir,
          decision,
          sessionMode: "resume",
          threadMessages: null,
        });

        const beforeWorkdir = await snapshotWorkdir(workdir);
        const stdoutPath = join(agentStdoutDir, `${turnId}-${resumeInv.agent}-resume.log`);
        log(`-> ${formatInvocation(resumeInv)} (会話 ${saved.sessionId} の続き)`);
        const adapter = getAgentAdapter(resumeInv.agent);
        const r = await run(adapter.buildArgv(resumeInv, resumePrompt, sessionReq), {
          cwd: workdir,
          logPath,
          stdoutPath,
          timeoutMs: Math.max(1, deadline - Date.now()),
          env: buildAgentEnvOverrides(),
        });

        if (shutdownController.signal.aborted) return;

        if (r.timedOut) {
          result = {
            ok: false,
            timedOut: true,
            reason: `${formatInvocation(resumeInv)}: タイムアウト (${config.timeoutSec}s) した`,
          };
        } else {
          const out = adapter.readResult(r, sessionReq);
          if (out.text) {
            appendFileSync(logPath, out.text.endsWith("\n") ? out.text : `${out.text}\n`);
          }
          if (out.failure === null) {
            result = {
              ok: true,
              inv: resumeInv,
              sessionId: out.session ?? saved.sessionId,
              text: out.text,
            };
          } else {
            const afterWorkdir = await snapshotWorkdir(workdir);
            if (out.failure !== "unavailable") {
              const reason = `${formatInvocation(resumeInv)}: resume が異常終了 (exit ${r.code}) したため新規セッションへ切り替えない`;
              error(reason);
              result = { ok: false, timedOut: false, reason };
            } else if (afterWorkdir !== beforeWorkdir) {
              const reason = `${formatInvocation(resumeInv)}: resume 中に作業ディレクトリを変更した後に利用不能 (exit ${r.code}) となったため新規セッションへ切り替えない`;
              error(reason);
              result = { ok: false, timedOut: false, reason };
            } else {
              warn(
                `${formatInvocation(resumeInv)}: resume が利用不能 (exit ${r.code}) のためスレッド履歴を読み直して新規セッションで引き継ぐ`,
              );
              const history = await fetchThreadMessagesSafe(decision.channel, decision.threadTs);
              const fallbackPrompt = buildSlackPrompt({
                config,
                botDisplayName,
                soulText,
                nowIso: new Date().toISOString(),
                workdir,
                decision,
                sessionMode: "fallback-start",
                threadMessages: history.messages,
                threadHistoryError: history.error,
              });
              result = await runAgentChain(fallbackPrompt, chain, deadline, turnId);
            }
          }
        }
      } else {
        const history = await fetchThreadMessagesSafe(decision.channel, decision.threadTs);
        const startPrompt = buildSlackPrompt({
          config,
          botDisplayName,
          soulText,
          nowIso: new Date().toISOString(),
          workdir,
          decision,
          sessionMode: "start",
          threadMessages: history.messages,
          threadHistoryError: history.error,
        });
        result = await runAgentChain(startPrompt, chain, deadline, turnId);
      }

      if (shutdownController.signal.aborted) return;

      const nowIso = new Date().toISOString();
      if (result.ok) {
        const replied = await postReply(decision.channel, decision.threadTs, result.text);
        if (replied) replyPosted = true;
        saveSessionSafely({
          botName: config.name,
          channel: decision.channel,
          threadTs: decision.threadTs,
          participated: replied || Boolean(saved?.participated),
          agent: result.inv.agent,
          ...(result.inv.model ? { model: result.inv.model } : {}),
          ...(result.inv.effort ? { effort: result.inv.effort } : {}),
          sessionId: result.sessionId,
          lastProcessedTs: decision.messageTs,
          createdAt: saved?.createdAt ?? nowIso,
          updatedAt: nowIso,
        });
        log(`スレッド処理完了: key=${key}`);
      } else {
        error(`スレッド処理失敗: key=${key} reason=${result.reason}`);
        const replied = await postReply(
          decision.channel,
          decision.threadTs,
          `[エラー] 調査・処理に失敗した: ${result.reason}`,
        );
        if (replied) replyPosted = true;
        if (replied && !saved) {
          saveSessionSafely({
            botName: config.name,
            channel: decision.channel,
            threadTs: decision.threadTs,
            participated: true,
            agent: null,
            sessionId: null,
            lastProcessedTs: decision.messageTs,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
      }
    } catch (e) {
      if (shutdownController.signal.aborted) return;
      const reason = e instanceof Error ? e.message : String(e);
      error(`スレッド処理中に予期しないエラー: key=${key} reason=${reason}`);
      if (!replyPosted) {
        const replied = await postReply(
          decision.channel,
          decision.threadTs,
          `[エラー] 調査・処理中にエラーが発生した: ${reason}`,
        );
        if (replied && !saved) {
          const nowIso = new Date().toISOString();
          saveSessionSafely({
            botName: config.name,
            channel: decision.channel,
            threadTs: decision.threadTs,
            participated: true,
            agent: null,
            sessionId: null,
            lastProcessedTs: decision.messageTs,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
      }
    }
  };

  try {
    log(`起動開始 (apiBaseUrl=${runtimeEnv.apiBaseUrl}, concurrency=${config.concurrency})`);
    const identity = await slackClient.waitForAuthTest({
      initialDelayMs: opts.authRetryInitialMs,
      maxDelayMs: opts.authRetryMaxMs,
      signal: shutdownController.signal,
      onRetry: (err, delayMs) => {
        warn(
          `auth.test 待機中 (${err instanceof Error ? err.message : String(err)})。${delayMs}ms 後に再試行`,
        );
      },
    });
    log(
      `auth.test 成功: user_id=${identity.userId}, bot_id=${identity.botId ?? "-"}, user=${identity.userName ?? "-"}`,
    );

    const onEvent = (event: SlackEvent) => {
      const decision = router.route(event, {
        identity,
        isParticipatingThread: (ch, ts) => {
          const k = threadKey(ch, ts);
          return (
            sessionStore.hasParticipated(ch, ts) ||
            Boolean(fallbackSessions.get(k)?.participated) ||
            queue.hasPendingOrActive(k)
          );
        },
      });
      if (!decision) return;

      const key = threadKey(decision.channel, decision.threadTs);
      void queue
        .enqueue(key, async () => {
          if (shutdownController.signal.aborted) return;
          await handleDecision(decision, identity);
        })
        .catch((err) => {
          error(
            `キュー実行中に未処理エラー: key=${key} reason=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    };

    socketClient = new SocketModeClient({
      client: slackClient,
      onEvent,
      log,
      warn,
      pingIntervalMs: opts.pingIntervalMs,
      inactivityTimeoutMs: opts.inactivityTimeoutMs,
      helloTimeoutMs: opts.helloTimeoutMs,
      initialBackoffMs: opts.initialBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
    });

    await socketClient.start();
    await queue.drain();
    log("停止完了");
    return 0;
  } catch (e) {
    if (shutdownController.signal.aborted) {
      await queue.drain();
      return 0;
    }
    error(e instanceof Error ? e.message : String(e));
    socketClient?.stop();
    await queue.drain();
    return 1;
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
    socketClient?.stop();
    botLock.handle.release();
  }
}
