export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * コマンドを実行し、出力を文字列で返す。
 */
export async function capture(
  cmd: string[],
  cwd: string = process.cwd(),
  env?: Record<string, string | undefined>,
): Promise<ProcessResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}
