import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

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
}

export interface RunResult {
  code: number;
  stdout: string;
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
    let stdout = "";
    // 窓口が進捗を読めるよう、溜めずに逐次書き出す。
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      appendFileSync(opts.stdoutPath ?? opts.logPath, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => appendFileSync(opts.logPath, chunk));
    const done = (code: number) => {
      if (child.pid) active.delete(child.pid);
      resolve({ code, stdout });
    };
    child.on("error", (e) => {
      appendFileSync(opts.logPath, `${cmd}: ${e.message}\n`);
      done(127);
    });
    child.on("close", (code) => done(code ?? 1));
  });
}

/** 出力を取るだけの短いコマンド（git / gh）。 */
export async function capture(
  argv: string[],
  cwd: string,
): Promise<RunResult & { stderr: string }> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("empty argv");
  const proc = Bun.spawn([cmd, ...args], { cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout: out.trim(), stderr: err.trim() };
}

/** 実行中の子をプロセスグループごと止める。 */
export function killAll(): void {
  for (const pid of active) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
}
