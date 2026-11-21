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
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {}
          killTimer = setTimeout(() => {
            if (!settled && child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            }
          }, 500);
          killTimer.unref();
        }
      }, opts.timeoutMs);
      timeoutTimer.unref();
    }

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
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
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
export async function capture(
  argv: string[],
  cwd: string,
  opts: { trim?: boolean } = {},
): Promise<RunResult & { stderr: string }> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("empty argv");
  const proc = Bun.spawn([cmd, ...args], { cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    code: await proc.exited,
    stdout: opts.trim === false ? out : out.trim(),
    stderr: err.trim(),
  };
}

/** 実行中の子をプロセスグループごと止める。 */
export function killAll(): void {
  for (const pid of active) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
}
