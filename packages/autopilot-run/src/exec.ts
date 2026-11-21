import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";

/**
 * 子プロセスの実行。
 *
 * - 裏の作業は Orca から見えないようにする。ORCA_* を渡すと、エージェントの状態フックが
 *   窓口のペインに報告して、途中で通知が鳴ってしまう。
 * - 停止時に孫プロセス（エージェントが起動したビルド等）ごと止めるため、
 *   子ごとに別のプロセスグループで起動する。
 */

const active = new Set<number>();

export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !k.startsWith("ORCA_")) out[k] = v;
  }
  return out;
}

export interface RunOptions {
  cwd: string;
  /** 標準出力の書き込み先。省略時は logPath に追記する。 */
  stdoutPath?: string;
  /** 標準エラー（と stdoutPath 未指定時の標準出力）の追記先。 */
  logPath: string;
  /** 指定ミリ秒を超えたら子プロセスグループごと停止する。 */
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

function attachGroupTimeout(
  pid: number | undefined,
  timeoutMs: number | undefined,
  isSettled: () => boolean,
  onTimeout: () => void,
): () => void {
  if (timeoutMs === undefined || timeoutMs <= 0) return () => {};
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    onTimeout();
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    killTimer = setTimeout(() => {
      if (!isSettled()) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    }, 500);
    killTimer.unref();
  }, timeoutMs);
  timeoutTimer.unref();
  return () => {
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
  };
}

export function run(argv: string[], opts: RunOptions): Promise<RunResult> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("empty argv");
  if (opts.stdoutPath) writeFileSync(opts.stdoutPath, "");
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid) active.add(child.pid);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const clearTimers = attachGroupTimeout(
      child.pid,
      opts.timeoutMs,
      () => settled,
      () => {
        timedOut = true;
      },
    );

    // 窓口が進捗を読めるよう、溜めずに逐次書き出す。
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      appendFileSync(opts.stdoutPath ?? opts.logPath, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      appendFileSync(opts.logPath, chunk);
    });
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (child.pid) active.delete(child.pid);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };
    child.on("error", (e) => {
      appendFileSync(opts.logPath, `${cmd}: ${e.message}\n`);
      done(127);
    });
    child.on("close", (code, signal) =>
      done(code ?? (signal ? 128 + constants.signals[signal] : 1)),
    );
  });
}

/** 出力を取るだけの短いコマンド（git / gh）。 */
export function capture(
  argv: string[],
  cwd: string,
  opts: { trim?: boolean; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult & { stderr: string }> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("empty argv");
  const env = opts.env ? { ...cleanEnv(), ...opts.env } : cleanEnv();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const clearTimers = attachGroupTimeout(
      child.pid,
      opts.timeoutMs,
      () => settled,
      () => {
        timedOut = true;
      },
    );

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const outText = Buffer.concat(stdout).toString("utf8");
      const errText = Buffer.concat(stderr).toString("utf8");
      resolve({
        code,
        stdout: opts.trim === false ? outText : outText.trim(),
        stderr: errText.trim(),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };

    child.on("error", (e) => {
      stderr.push(Buffer.from(e.message));
      done(127);
    });
    child.on("close", (code, signal) =>
      done(code ?? (signal ? 128 + constants.signals[signal] : 1)),
    );
  });
}

/** 実行中の子をプロセスグループごと止める。 */
export function killAll(): void {
  for (const pid of active) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
}
