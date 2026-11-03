#!/usr/bin/env bun
import { extractGhTexts, resolveRealGh, scanText } from "./detector.ts";

/**
 * safe-gh: GitHub CLI の機密情報漏洩防止ラッパー。
 * gh コマンドへの自由記述引数・ファイルをスキャンし、機密検知時は送信を遮断する。
 */
export async function runSafeGh(args: string[]): Promise<number> {
  // まず引数からスキャン要否と stdin 読み込み要否を判定
  const initial = extractGhTexts(args);

  let stdinText: string | undefined;

  // stdin が必要と指定された場合のみ読み込む（読み取り系のパイプハングを防止）
  if (initial.shouldScan && initial.needsStdin && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    stdinText = Buffer.concat(chunks).toString("utf8");
  }

  // stdinText がある場合は再抽出
  const { shouldScan, texts } =
    initial.needsStdin && stdinText !== undefined ? extractGhTexts(args, stdinText) : initial;

  if (shouldScan) {
    for (const text of texts) {
      const res = await scanText(text);
      if (!res.ok) {
        console.error(
          `\x1b[31m[safe-gh] 機密情報が検知されたため GitHub への送信を中断しました:\x1b[0m ${res.reason}`,
        );
        if (res.detail) {
          console.error(res.detail);
        }
        return 1;
      }
    }
  }

  // クリーンまたは対象外コマンド: 本物の gh に透過転送
  const realGh = resolveRealGh();
  const proc = Bun.spawn([realGh, ...args], {
    stdin: stdinText !== undefined ? "pipe" : "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  if (stdinText !== undefined && proc.stdin) {
    proc.stdin.write(stdinText);
    proc.stdin.end();
  }

  return await proc.exited;
}

if (import.meta.main) {
  runSafeGh(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[safe-gh] 実行エラー: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
