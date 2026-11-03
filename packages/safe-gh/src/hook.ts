#!/usr/bin/env bun
import { resolveLocalHook, scanStaged } from "./detector.ts";

/**
 * pre-commit フックの実行。
 * ステージされた差分の機密情報検査（SOPS + gitleaks）を実行後、
 * リポジトリローカルの既存フックがあれば連鎖実行する。
 */
export async function runPreCommit(
  cwd: string = process.cwd(),
  hookArgs: string[] = [],
): Promise<number> {
  const res = await scanStaged(cwd);
  if (!res.ok) {
    console.error(
      `\x1b[31m[safe-gh:hook] 機密情報が検知されたためコミットを中断しました:\x1b[0m ${res.reason}`,
    );
    if (res.detail) {
      console.error(res.detail);
    }
    return 1;
  }

  // リポジトリ側の既存 pre-commit フック（husky, pre-commit framework 等）があれば連鎖実行
  const localHook = await resolveLocalHook(cwd);
  if (localHook) {
    const child = Bun.spawn([localHook, ...hookArgs], {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await child.exited;
    if (code !== 0) return code;
  }

  return 0;
}

if (import.meta.main) {
  runPreCommit(process.cwd(), process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(
        `[safe-gh:hook] 実行エラー: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    },
  );
}
