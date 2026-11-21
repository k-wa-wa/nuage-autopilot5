import { createHash } from "node:crypto";
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
import { formatInvocation, getAgentAdapter } from "../../autopilot-run/src/agents.ts";
import { capture, killAll, run } from "../../autopilot-run/src/exec.ts";
import { loadModelTable, MODELS_PATH, resolveTaskChain } from "../../autopilot-run/src/models.ts";
import type { TaskConfig, TaskMemory } from "./config.ts";
import {
  acquireLockWithWait,
  type LockHandle,
  memoryLockPath,
  resolveStateDir,
  taskLockPath,
  tryAcquireLock,
} from "./lock.ts";
import { type PreparedMemory, prepareMemory, rollbackFailedMemory, syncMemory } from "./memory.ts";
import { buildTaskPrompt } from "./prompt.ts";

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
        {
          trim: false,
        },
      ),
      capture(["git", "-C", workdir, "diff", "HEAD"], workdir, { trim: false }),
    ]);
    for (const p of parts) hash.update(`${p.stdout}\0`);
  } else {
    hashDirEntries(workdir, "", hash);
  }
  return hash.digest("hex");
}

async function snapshotMemoryState(memory: TaskMemory): Promise<string> {
  const hash = createHash("sha256");
  const status = await capture(
    ["git", "-C", memory.repo, "status", "--porcelain=v1", "--untracked-files=all"],
    memory.repo,
    { trim: false },
  );
  hash.update(`${status.stdout}\0`);
  const filePath = join(memory.repo, memory.file);
  if (existsSync(filePath)) {
    hash.update(readFileSync(filePath));
  } else {
    hash.update("<missing>");
  }
  return hash.digest("hex");
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

    let preparedMemory: PreparedMemory | null = null;
    if (config.memory) {
      const memLock = await acquireLockWithWait(memoryLockPath(stateDir, config.memory.repo));
      activeMemLock = memLock;
      try {
        preparedMemory = await prepareMemory(config.memory, { warn });
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
      memoryContent: preparedMemory?.content ?? null,
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
      const beforeWorkdir = await snapshotWorkdir(workdir);
      const beforeMemory = config.memory ? await snapshotMemoryState(config.memory) : "";

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
        const afterWorkdir = await snapshotWorkdir(workdir);
        const afterMemory = config.memory ? await snapshotMemoryState(config.memory) : "";
        if (afterWorkdir !== beforeWorkdir || afterMemory !== beforeMemory) {
          error(
            `${formatInvocation(inv)}: 作業ツリーまたは記憶ファイルを変更した後に利用不能 (exit ${r.code}) となったため別候補へ切り替えない`,
          );
          break;
        }
        warn(`${formatInvocation(inv)}: 利用不能 (exit ${r.code}) のため次候補へ切り替える`);
        continue;
      }
      error(`${formatInvocation(inv)}: 異常終了 (exit ${r.code})`);
      break;
    }

    if (!agentOk) {
      if (config.memory && preparedMemory) {
        const memLock = await acquireLockWithWait(memoryLockPath(stateDir, config.memory.repo));
        activeMemLock = memLock;
        try {
          rollbackFailedMemory(config.memory, preparedMemory, { log });
        } finally {
          memLock.release();
          activeMemLock = null;
        }
      }
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
