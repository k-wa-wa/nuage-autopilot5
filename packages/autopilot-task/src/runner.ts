import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatInvocation, getAgentAdapter } from "../../autopilot-run/src/agents.ts";
import { killAll, run } from "../../autopilot-run/src/exec.ts";
import { loadModelTable, MODELS_PATH, resolveTaskChain } from "../../autopilot-run/src/models.ts";
import type { TaskConfig } from "./config.ts";
import {
  acquireLockWithWait,
  type LockHandle,
  memoryLockPath,
  resolveStateDir,
  taskLockPath,
  tryAcquireLock,
} from "./lock.ts";
import { prepareMemory, syncMemory } from "./memory.ts";
import { buildTaskPrompt } from "./prompt.ts";

function appendLog(logPath: string, prefix: string, msg: string): void {
  const time = new Date().toISOString();
  appendFileSync(logPath, `[${time}] ${prefix}${msg}\n`);
}

export interface RunTaskOptions {
  config: TaskConfig;
  eventContent: string | null;
}

/**
 * 汎用タスクを 1 回実行する。
 * 排他ロック取得中や precheck 失敗時はエラーにせずスキップして 0 を返す。
 */
export async function runTask(opts: RunTaskOptions): Promise<number> {
  const { config, eventContent } = opts;
  const stateDir = resolveStateDir();
  const logPath = join(stateDir, "logs", `task-${config.name}.log`);
  const stdoutPath = join(stateDir, "logs", `task-${config.name}-agent.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  const log = (msg: string) => {
    console.log(`[autopilot-task:${config.name}] ${msg}`);
    appendLog(logPath, "", msg);
  };
  const warn = (msg: string) => {
    console.warn(`[autopilot-task:${config.name}] WARN: ${msg}`);
    appendLog(logPath, "WARN: ", msg);
  };
  const error = (msg: string) => {
    console.error(`[autopilot-task:${config.name}] ERROR: ${msg}`);
    appendLog(logPath, "ERROR: ", msg);
  };

  const taskLock = tryAcquireLock(taskLockPath(stateDir, config.name));
  if (!taskLock.acquired) {
    log(`すでに実行中 (pid=${taskLock.pid ?? "unknown"}) のためスキップする`);
    return 0;
  }

  let activeMemLock: LockHandle | null = null;
  const onSignal = () => {
    killAll();
    activeMemLock?.release();
    taskLock.handle.release();
    process.exit(143);
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const sig of signals) process.on(sig, onSignal);

  try {
    const workdir = config.workdir ?? join(stateDir, "workdirs", config.name);
    if (existsSync(workdir) && !statSync(workdir).isDirectory()) {
      error(`workdir がディレクトリではない: ${workdir}`);
      return 1;
    }
    mkdirSync(workdir, { recursive: true });

    if (config.precheck) {
      log(`precheck 実行: ${config.precheck.command}`);
      const pre = await run(["sh", "-c", config.precheck.command], {
        cwd: workdir,
        logPath,
        timeoutMs: config.precheck.timeoutSec * 1000,
      });
      if (pre.timedOut) {
        log(`precheck がタイムアウト (${config.precheck.timeoutSec}s) したためスキップする`);
        return 0;
      }
      if (pre.code !== 0) {
        log(`precheck が終了コード ${pre.code} で失敗したためスキップする`);
        return 0;
      }
    }

    let memoryContent: string | null = null;
    if (config.memory) {
      const memLock = await acquireLockWithWait(memoryLockPath(stateDir, config.memory.repo));
      activeMemLock = memLock;
      try {
        const prepared = await prepareMemory(config.memory, { warn });
        memoryContent = prepared.content;
      } finally {
        memLock.release();
        activeMemLock = null;
      }
    }

    const modelsPath = process.env.AUTOPILOT_MODELS || MODELS_PATH;
    const models = loadModelTable(modelsPath) ?? {};
    const chain = resolveTaskChain(config.agent, config.level, models);
    const soulText = readFileSync(config.soulFile, "utf8");
    const prompt = buildTaskPrompt({
      config,
      soulText,
      nowIso: new Date().toISOString(),
      workdir,
      eventContent,
      memoryContent,
    });

    log(`エージェント開始: candidates=${chain.map(formatInvocation).join(" -> ")}`);
    const deadline = Date.now() + config.timeoutSec * 1000;
    let agentOk = false;

    for (const inv of chain) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        error(`タスクがタイムアウト (${config.timeoutSec}s) した`);
        break;
      }
      log(`-> ${formatInvocation(inv)}`);
      const adapter = getAgentAdapter(inv.agent);
      const r = await run(adapter.buildArgv(inv, prompt), {
        cwd: workdir,
        logPath,
        stdoutPath,
        timeoutMs: remainingMs,
      });
      if (r.timedOut) {
        error(`${formatInvocation(inv)}: タイムアウト (${config.timeoutSec}s) のため停止した`);
        break;
      }
      const out = adapter.readResult(r);
      if (out.text) {
        appendFileSync(logPath, out.text.endsWith("\n") ? out.text : `${out.text}\n`);
      }
      if (out.failure === null) {
        agentOk = true;
        break;
      }
      if (out.failure === "unavailable") {
        warn(`${formatInvocation(inv)}: 利用不能 (exit ${r.code}) のため次候補へ切り替える`);
        continue;
      }
      error(`${formatInvocation(inv)}: 異常終了 (exit ${r.code})`);
      break;
    }

    if (!agentOk) {
      return 1;
    }

    if (config.memory) {
      const memLock = await acquireLockWithWait(memoryLockPath(stateDir, config.memory.repo));
      activeMemLock = memLock;
      try {
        const synced = await syncMemory(config.memory, config.name, { log, error });
        if (!synced.ok) return 1;
      } finally {
        memLock.release();
        activeMemLock = null;
      }
    }

    log("完了");
    return 0;
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
    activeMemLock?.release();
    taskLock.handle.release();
  }
}
