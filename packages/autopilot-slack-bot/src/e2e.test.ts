import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { parseSlackBotConfig } from "./config.ts";
import { runSlackBot } from "./runner.ts";

const MAIN = join(import.meta.dir, "main.ts");

interface RecordedCall {
  agent: string;
  args: string[];
  prompt: string;
  cwd: string;
  envOrca: string[];
}

interface PostedMessage {
  channel: string;
  thread_ts?: string;
  text: string;
}

interface WorldCleanup {
  dir: string;
  servers: Array<{ stop: (closeActive?: boolean) => void }>;
  restoreEnv: () => void;
}

const cleanups: WorldCleanup[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    for (const s of c.servers) s.stop(true);
    c.restoreEnv();
    rmSync(c.dir, { recursive: true, force: true });
  }
});

function setupWorld(agentScript: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "autopilot-slack-e2e-"));
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  const callsPath = join(root, "calls.jsonl");
  const counterPath = join(root, "counter.txt");
  const scriptPath = join(root, "agent-script.json");
  const soul = join(root, "SOUL.md");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(soul, "# Test Slack Soul\n調査結果をスレッドへ報告すること。\n");
  writeFileSync(scriptPath, JSON.stringify(agentScript));
  writeFileSync(counterPath, "0");

  const installFakeAgent = (name: "claude" | "agy" | "codex") => {
    const wrapper = join(bin, name);
    writeFileSync(
      wrapper,
      `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const envOrca = Object.keys(process.env).filter((k) => k.startsWith("ORCA_"));
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ agent: ${JSON.stringify(name)}, args, prompt, cwd: process.cwd(), envOrca }) + "\\n");

const idx = Number(readFileSync(${JSON.stringify(counterPath)}, "utf8")) + 1;
writeFileSync(${JSON.stringify(counterPath)}, String(idx));
const script = JSON.parse(readFileSync(${JSON.stringify(scriptPath)}, "utf8"));
const byTs = Object.entries(script.byPrompt ?? {}).find(([k]) => prompt.includes(k))?.[1];
const step = byTs ?? script[String(idx)] ?? script[${JSON.stringify(name)}] ?? { code: 0, stdout: "ok" };
if (step.sleepMs) await Bun.sleep(step.sleepMs);
if (step.writeWorkdirFile) {
  writeFileSync(step.writeWorkdirFile, step.writeWorkdirContent ?? "dirty\\n");
}
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.code ?? 0);
`,
    );
    chmodSync(wrapper, 0o755);
  };
  installFakeAgent("claude");
  installFakeAgent("agy");
  installFakeAgent("codex");

  const savedEnv = {
    PATH: process.env.PATH,
    AUTOPILOT_STATE_DIR: process.env.AUTOPILOT_STATE_DIR,
    AUTOPILOT_MODELS: process.env.AUTOPILOT_MODELS,
    SLACK_API_BASE_URL: process.env.SLACK_API_BASE_URL,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    ORCA_PANE_KEY: process.env.ORCA_PANE_KEY,
  };

  process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
  process.env.AUTOPILOT_STATE_DIR = stateDir;

  const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
  cleanups.push({
    dir: root,
    servers,
    restoreEnv: () => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  });

  const readCalls = (): RecordedCall[] => {
    try {
      return readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RecordedCall);
    } catch {
      return [];
    }
  };

  const setScript = (next: Record<string, unknown>) => {
    writeFileSync(scriptPath, JSON.stringify(next));
  };

  return { root, bin, stateDir, soul, servers, readCalls, setScript };
}

function createMockSlackServer(opts: {
  botUserId?: string;
  botId?: string;
  authFailCount?: number;
  threads?: Record<string, Array<Record<string, unknown>>>;
}) {
  const botUserId = opts.botUserId ?? "U_CUSTOM_BOT";
  const botId = opts.botId ?? "B_CUSTOM_BOT";
  let authFailuresRemaining = opts.authFailCount ?? 0;

  const posted: PostedMessage[] = [];
  const repliesCalls: Array<{ channel: string; ts: string }> = [];
  const acked: string[] = [];
  const wsClients = new Set<ServerWebSocket<unknown>>();
  let postCounter = 0;

  let port = 0;
  const srv = Bun.serve({
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/slack/socket") {
        if (server.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (!url.pathname.startsWith("/slack/api/")) {
        return new Response("not found", { status: 404 });
      }
      const method = url.pathname.slice("/slack/api/".length);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

      if (method === "auth.test") {
        if (authFailuresRemaining > 0) {
          authFailuresRemaining--;
          return Response.json({ ok: false, error: "starting" }, { status: 503 });
        }
        return Response.json({ ok: true, user_id: botUserId, bot_id: botId, user: "test-bot" });
      }
      if (method === "apps.connections.open") {
        return Response.json({
          ok: true,
          url: `ws://127.0.0.1:${port}/slack/socket?ticket=t1`,
        });
      }
      if (method === "conversations.replies") {
        const channel = String(body.channel ?? "");
        const ts = String(body.ts ?? "");
        repliesCalls.push({ channel, ts });
        const messages = opts.threads?.[`${channel}:${ts}`] ?? [];
        return Response.json({ ok: true, messages, has_more: false });
      }
      if (method === "chat.postMessage") {
        postCounter++;
        const msg: PostedMessage = {
          channel: String(body.channel ?? ""),
          ...(typeof body.thread_ts === "string" ? { thread_ts: body.thread_ts } : {}),
          text: String(body.text ?? ""),
        };
        posted.push(msg);
        return Response.json({ ok: true, channel: msg.channel, ts: `bot.${postCounter}` });
      }
      return Response.json({ ok: false, error: "unknown_method" });
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        ws.send(JSON.stringify({ type: "hello", num_connections: wsClients.size }));
      },
      message(_ws, raw) {
        const parsed = JSON.parse(String(raw)) as { envelope_id?: string };
        if (parsed.envelope_id) acked.push(parsed.envelope_id);
      },
      close(ws) {
        wsClients.delete(ws);
      },
    },
  });
  port = srv.port ?? 0;

  let envSeq = 0;
  const emitEvent = (event: Record<string, unknown>) => {
    const ws = [...wsClients][0];
    if (!ws) throw new Error("no ws connected");
    envSeq++;
    ws.send(
      JSON.stringify({
        envelope_id: `env-${envSeq}`,
        type: "events_api",
        payload: {
          type: "event_callback",
          event,
        },
      }),
    );
  };

  return {
    srv,
    baseUrl: `http://127.0.0.1:${srv.port}/slack/api/`,
    posted,
    repliesCalls,
    acked,
    wsClients,
    emitEvent,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await Bun.sleep(15);
  }
  throw new Error("waitFor timeout");
}

describe("autopilot-slack-bot E2E", () => {
  test("check-config は妥当な設定で 0、不正な設定で 2 を返す", async () => {
    const w = setupWorld();
    const okCfg = join(w.root, "ok.json");
    writeFileSync(okCfg, JSON.stringify({ name: "valid-bot", soulFile: w.soul }));
    const badCfg = join(w.root, "bad.json");
    writeFileSync(badCfg, JSON.stringify({ name: "bad-bot", soulFile: join(w.root, "none.md") }));

    const runCli = async (args: string[]) => {
      const p = Bun.spawn([process.execPath, MAIN, ...args], {
        cwd: w.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, stdout, stderr };
    };

    const r1 = await runCli(["check-config", "--file", okCfg]);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain("valid-bot: ok");

    const r2 = await runCli(["check-config", "--file", badCfg]);
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain("soulFile");
  });

  test("起動リトライ・重複排除・会話継続 (resume)・履歴引き継ぎ・自己ループ防止が連動して動く", async () => {
    const w = setupWorld({
      // 1 ターン目: agy 起動で JSON conversation_id を返す
      "1": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "agy-conv-1", response: "一次調査完了" }),
      },
      // 2 ターン目: agy --conversation で継続
      "2": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "agy-conv-1", response: "追加確認完了" }),
      },
      // 3 ターン目: resume が期限切れで失敗 -> 4 ターン目で start フォールバック
      "3": {
        code: 1,
        stderr: "conversation not found",
      },
      "4": {
        code: 0,
        stdout: JSON.stringify({
          conversation_id: "agy-conv-2",
          response: "新規セッションで引き継ぎ完了",
        }),
      },
    });

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;
    process.env.ORCA_PANE_KEY = "should-not-leak";

    const mock = createMockSlackServer({
      botUserId: "U_DYN_BOT",
      botId: "B_DYN_BOT",
      authFailCount: 2,
      threads: {
        "C_OPS:100.1": [
          { ts: "100.1", bot_id: "B_AM", username: "alertmanager", text: "[firing] HighErrorRate" },
          { ts: "100.2", user: "U_ALICE", text: "<@U_DYN_BOT> 原因を調べて", thread_ts: "100.1" },
        ],
      },
    });
    w.servers.push(mock.srv);

    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({
        name: "ops-investigator",
        soulFile: w.soul,
        apiBaseUrl: "http://127.0.0.1:9999/unused", // 環境変数 SLACK_API_BASE_URL が優先される
      }),
    );

    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);

    // 自分自身・他 bot の投稿は無視される
    mock.emitEvent({
      type: "message",
      channel: "C_OPS",
      user: "U_DYN_BOT",
      ts: "99.1",
      text: "self",
    });
    mock.emitEvent({
      type: "app_mention",
      channel: "C_OPS",
      user: "U_OTHER_BOT",
      bot_id: "B_OTHER",
      ts: "99.2",
      text: "<@U_DYN_BOT> loop",
    });

    // 1 ターン目: message と app_mention の両方が同一 ts で来ても 1 回だけ処理される
    const turn1Event = {
      channel: "C_OPS",
      user: "U_ALICE",
      ts: "100.2",
      thread_ts: "100.1",
      text: "<@U_DYN_BOT> 原因を調べて",
    };
    mock.emitEvent({ ...turn1Event, type: "message" });
    mock.emitEvent({ ...turn1Event, type: "app_mention" });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]).toEqual({
      channel: "C_OPS",
      thread_ts: "100.1",
      text: "一次調査完了",
    });
    expect(mock.repliesCalls).toEqual([{ channel: "C_OPS", ts: "100.1" }]);

    // 2 ターン目: 参加済みスレッドへのメンション無し返信 -> resume で継続される
    mock.emitEvent({
      type: "message",
      channel: "C_OPS",
      user: "U_ALICE",
      ts: "100.3",
      thread_ts: "100.1",
      text: "関連 PR も見て",
    });

    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]!.text).toBe("追加確認完了");

    // 3 ターン目: resume 失敗 -> conversations.replies を読み直して新規セッションで引き継ぐ
    mock.emitEvent({
      type: "message",
      channel: "C_OPS",
      user: "U_ALICE",
      ts: "100.4",
      thread_ts: "100.1",
      text: "最後に要約して",
    });

    await waitFor(() => mock.posted.length === 3);
    expect(mock.posted[2]!.text).toBe("新規セッションで引き継ぎ完了");
    expect(mock.repliesCalls).toHaveLength(2);

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);

    const calls = w.readCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0]!.envOrca).toEqual([]);
    expect(calls[0]!.prompt).toContain("[firing] HighErrorRate");
    expect(calls[1]!.args).toContain("--conversation");
    expect(calls[1]!.args).toContain("agy-conv-1");
    expect(calls[2]!.args).toContain("--conversation");
    expect(calls[2]!.args).toContain("agy-conv-1");
    expect(calls[3]!.args).not.toContain("--conversation");
    expect(calls[3]!.prompt).toContain("[firing] HighErrorRate");
  });

  test("unavailable 時は次候補へフォールバックし、作業ディレクトリ変更後なら切り替えずスレッドへエラー通知する", async () => {
    const w = setupWorld({
      // 1 回目 (agy): 何も変えずに利用上限で失敗 -> 2 回目 (claude) へ切り替え
      "1": { code: 1, stderr: "You've hit your session limit" },
      "2": { code: 0, stdout: "claude が調査完了" },
    });

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const workdir = join(w.root, "work");
    mkdirSync(workdir);

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "fallback-bot", soulFile: w.soul, workdir }),
    );

    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "200.1",
      text: "<@U_CUSTOM_BOT> check",
    });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]!.text).toBe("claude が調査完了");

    // 次スレッドで作業ディレクトリを変更した上で unavailable -> 切り替えずエラー通知
    w.setScript({
      "3": {
        code: 1,
        stderr: "You've hit your session limit",
        writeWorkdirFile: join(workdir, "touched.txt"),
      },
      "4": { code: 0, stdout: "should not run" },
    });

    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "300.1",
      text: "<@U_CUSTOM_BOT> check2",
    });

    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]!.text).toContain("[エラー]");
    expect(mock.posted[1]!.text).toContain("切り替えない");

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
    expect(w.readCalls().map((c) => c.agent)).toEqual(["agy", "claude", "agy"]);
  });

  test("同一スレッドの連続投稿は直列実行し、異なるスレッドは並列実行する", async () => {
    const w = setupWorld({
      byPrompt: {
        '"ts": "10.1"': { code: 0, sleepMs: 180, stdout: "reply-A1" },
        '"ts": "10.2"': { code: 0, sleepMs: 10, stdout: "reply-A2" },
        '"ts": "20.1"': { code: 0, sleepMs: 20, stdout: "reply-B1" },
      },
    });

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "concurrency-bot", soulFile: w.soul, concurrency: 2 }),
    );

    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);

    // スレッド A に 2 件、スレッド B に 1 件を同時に投げる
    mock.emitEvent({ type: "app_mention", channel: "C1", user: "U1", ts: "10.1", text: "A1" });
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "10.2",
      thread_ts: "10.1",
      text: "A2",
    });
    mock.emitEvent({ type: "app_mention", channel: "C1", user: "U1", ts: "20.1", text: "B1" });

    await waitFor(() => mock.posted.length === 3);

    // B1 は A1 と並列に走って先に完了し、A2 は A1 完了後に直列実行される
    expect(mock.posted.map((m) => `${m.thread_ts}:${m.text}`)).toEqual([
      "20.1:reply-B1",
      "10.1:reply-A1",
      "10.1:reply-A2",
    ]);

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });
});
