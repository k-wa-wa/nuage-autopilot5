import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./exec.ts";

/**
 * 機密情報漏洩防止（Secret Shield）モジュール。
 *
 * 1. Git pre-commit フック:
 *    - 未暗号化 SOPS ファイル（secrets*.yaml 等の平文コミット、sops_mac 不在）を検査
 *    - gitleaks git --staged でステージされた差分を検査
 * 2. gh セーフラッパー:
 *    - gh pr create/edit/comment, gh issue create/edit/comment, gh api のテキスト引数・stdin を抽出
 *    - gitleaks stdin で機密情報をスキャン
 *    - 機密情報検知時は exit 1 でブロック（本物の gh は呼ばない）
 *    - 機密情報なし／読み取りコマンドは本物の gh に透過転送
 */

/** SOPS 暗号化対象となるファイルパスパターンか判定（.sops.yaml 設定ファイルは除く）。 */
export function isSopsCandidateFile(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  if (base === ".sops.yaml" || base === ".sops.yml") return false;
  return (
    /(?:^|\/|\.)secrets?.*\.(?:ya?ml|json)$/i.test(filePath) ||
    /(?:^|\/)[^/]*secrets?[^/]*\.(?:ya?ml|json)$/i.test(base)
  );
}

/** 内容が SOPS で暗号化されているか判定（sops_mac または sops.mac: ENC[...] の存在）。 */
export function isEncryptedSops(content: string): boolean {
  if (/sops_mac\s*[:=]/i.test(content)) return true;
  if (/["']?sops["']?\s*:/i.test(content) && /["']?mac["']?\s*:\s*["']?ENC\[/i.test(content)) {
    return true;
  }
  return false;
}

export interface SopsCheckResult {
  ok: boolean;
  file?: string;
  reason?: string;
}

/**
 * ステージされたファイルのうち、未暗号化 SOPS ファイルを検査する。
 */
export async function checkUnencryptedSops(cwd: string = process.cwd()): Promise<SopsCheckResult> {
  const staged = await capture(
    ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
    cwd,
  );
  if (staged.code !== 0) {
    return { ok: false, reason: `git diff --cached failed: ${staged.stderr}` };
  }
  const files = staged.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  for (const file of files) {
    if (!isSopsCandidateFile(file)) continue;
    const contentRes = await capture(["git", "show", `:${file}`], cwd);
    if (contentRes.code !== 0) continue;
    if (!isEncryptedSops(contentRes.stdout)) {
      return {
        ok: false,
        file,
        reason: `未暗号化の SOPS ファイルが検出されました: ${file} (sops_mac 不在)`,
      };
    }
  }
  return { ok: true };
}

export interface ScanResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

/**
 * gitleaks stdin を用いて任意のテキストをスキャンする。
 */
export async function scanText(text: string): Promise<ScanResult> {
  if (!text.trim()) return { ok: true };

  const proc = Bun.spawn(["gitleaks", "stdin", "--verbose", "--no-banner", "--redact"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(text);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const detail = (stderr || stdout).trim();
    return {
      ok: false,
      reason: "テキスト内に機密情報が検知されました",
      detail,
    };
  }

  return { ok: true };
}

/**
 * コミット時の検査（SOPS 未暗号化チェック + gitleaks git --staged）。
 */
export async function scanStaged(cwd: string = process.cwd()): Promise<ScanResult> {
  const sops = await checkUnencryptedSops(cwd);
  if (!sops.ok) {
    return {
      ok: false,
      reason: sops.reason,
      detail: sops.file ? `対象ファイル: ${sops.file}` : undefined,
    };
  }

  const proc = Bun.spawn(["gitleaks", "git", "--staged", "--verbose", "--no-banner", "--redact"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const detail = (stderr || stdout).trim();
    return {
      ok: false,
      reason: "ステージされた変更内に機密情報が検知されました",
      detail,
    };
  }

  return { ok: true };
}

/**
 * gh コマンドライン引数と stdin から、スキャン対象のテキストを抽出する。
 */
export function extractGhTexts(
  args: string[],
  stdinText?: string,
): { shouldScan: boolean; texts: string[] } {
  // サブコマンドの特定（フラグを除く最初の位置引数たち）
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      // 値を取る主要フラグをスキップ
      if (
        [
          "-R",
          "--repo",
          "-t",
          "--title",
          "-b",
          "--body",
          "-F",
          "--body-file",
          "-f",
          "--field",
          "-X",
          "--method",
          "--input",
          "-H",
          "--header",
          "-q",
          "--jq",
        ].includes(arg)
      ) {
        i++; // 次の値をスキップ
      }
      continue;
    }
    positional.push(arg);
  }

  const cmd = positional.slice(0, 2).join(" ");
  const isPrOrIssue = [
    "pr create",
    "pr edit",
    "pr comment",
    "issue create",
    "issue edit",
    "issue comment",
  ].includes(cmd);
  const isApi = positional[0] === "api";

  if (!isPrOrIssue && !isApi) {
    return { shouldScan: false, texts: [] };
  }

  const texts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    // -t, --title
    if (arg === "-t" || arg === "--title") {
      if (i + 1 < args.length) texts.push(args[++i]!);
    } else if (arg.startsWith("-t=") || arg.startsWith("--title=")) {
      texts.push(arg.slice(arg.indexOf("=") + 1));
    }
    // -b, --body
    else if (arg === "-b" || arg === "--body") {
      if (i + 1 < args.length) texts.push(args[++i]!);
    } else if (arg.startsWith("-b=") || arg.startsWith("--body=")) {
      texts.push(arg.slice(arg.indexOf("=") + 1));
    }
    // -F, --body-file
    else if (arg === "-F" || arg === "--body-file") {
      if (i + 1 < args.length) {
        const filePath = args[++i]!;
        if (filePath === "-") {
          if (stdinText) texts.push(stdinText);
        } else if (existsSync(filePath)) {
          texts.push(readFileSync(filePath, "utf8"));
        }
      }
    } else if (arg.startsWith("-F=") || arg.startsWith("--body-file=")) {
      const filePath = arg.slice(arg.indexOf("=") + 1);
      if (filePath === "-") {
        if (stdinText) texts.push(stdinText);
      } else if (existsSync(filePath)) {
        texts.push(readFileSync(filePath, "utf8"));
      }
    }
    // gh api 固有の引数: -f, --field, -F, --raw-field, --input
    else if (isApi) {
      if (arg === "-f" || arg === "--field") {
        if (i + 1 < args.length) {
          const val = args[++i]!;
          const eq = val.indexOf("=");
          texts.push(eq !== -1 ? val.slice(eq + 1) : val);
        }
      } else if (arg.startsWith("-f=") || arg.startsWith("--field=")) {
        const val = arg.slice(arg.indexOf("=") + 1);
        const eq = val.indexOf("=");
        texts.push(eq !== -1 ? val.slice(eq + 1) : val);
      } else if (arg === "--input") {
        if (i + 1 < args.length) {
          const path = args[++i]!;
          if (path === "-") {
            if (stdinText) texts.push(stdinText);
          } else if (existsSync(path)) {
            texts.push(readFileSync(path, "utf8"));
          }
        }
      } else if (arg.startsWith("--input=")) {
        const path = arg.slice(arg.indexOf("=") + 1);
        if (path === "-") {
          if (stdinText) texts.push(stdinText);
        } else if (existsSync(path)) {
          texts.push(readFileSync(path, "utf8"));
        }
      } else if (arg.startsWith("{") && arg.endsWith("}")) {
        // raw JSON 引数
        texts.push(arg);
      }
    }
  }

  // gh api かつ stdin がパイプされている場合（引数で明示されなくても stdin が送信される場合がある）
  if (isApi && stdinText && !texts.includes(stdinText)) {
    texts.push(stdinText);
  }

  return { shouldScan: true, texts };
}

/**
 * pre-commit フックの実行。
 */
export async function runPreCommit(cwd: string = process.cwd()): Promise<number> {
  const res = await scanStaged(cwd);
  if (!res.ok) {
    console.error(
      `\x1b[31m[secret-shield] 機密情報が検知されたためコミットを中断しました:\x1b[0m ${res.reason}`,
    );
    if (res.detail) {
      console.error(res.detail);
    }
    return 1;
  }
  return 0;
}

/** 本物の gh のパスを取得する（無限再帰を防ぐ）。 */
export function resolveRealGh(): string {
  if (process.env.GH_REAL_PATH && existsSync(process.env.GH_REAL_PATH)) {
    return process.env.GH_REAL_PATH;
  }
  // PATH から自分自身以外の gh を探す
  const pathDirs = (process.env.PATH || "").split(":");
  const currentScript = process.argv[1];
  for (const dir of pathDirs) {
    const candidate = join(dir, "gh");
    if (existsSync(candidate) && candidate !== currentScript) {
      return candidate;
    }
  }
  return "gh";
}

/**
 * gh セーフラッパーの実行。
 */
export async function runSafeGh(args: string[]): Promise<number> {
  let stdinText: string | undefined;

  // stdin がパイプまたはリダイレクトされている場合は読み込む
  if (!process.stdin.isTTY) {
    const reader = process.stdin;
    const chunks: Buffer[] = [];
    for await (const chunk of reader) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    stdinText = Buffer.concat(chunks).toString("utf8");
  }

  const { shouldScan, texts } = extractGhTexts(args, stdinText);

  if (shouldScan) {
    for (const text of texts) {
      const res = await scanText(text);
      if (!res.ok) {
        console.error(
          `\x1b[31m[secret-shield] 機密情報が検知されたため GitHub への送信を中断しました:\x1b[0m ${res.reason}`,
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

/**
 * リポジトリの pre-commit フックを確実に有効化する。
 * autopilot-run の起動時等に呼ばれ、未暗号化 SOPS や機密情報のコミットを防止する。
 */
export async function ensureGitHooks(gitDir: string): Promise<void> {
  const hooksDir = join(gitDir, "hooks");
  const preCommitPath = join(hooksDir, "pre-commit");
  mkdirSync(hooksDir, { recursive: true });

  const hookContent = `#!/bin/sh
# autopilot secret-shield pre-commit hook
if command -v autopilot-run >/dev/null 2>&1; then
  exec autopilot-run shield pre-commit "$@"
elif [ -n "$AUTOPILOT_SHIELD_BIN" ] && [ -x "$AUTOPILOT_SHIELD_BIN" ]; then
  exec "$AUTOPILOT_SHIELD_BIN" pre-commit "$@"
fi
exit 0
`;

  // 既存の pre-commit があり、すでに autopilot-run や shield を呼んでいれば上書きしない
  if (existsSync(preCommitPath)) {
    const existing = readFileSync(preCommitPath, "utf8");
    if (existing.includes("shield pre-commit") || existing.includes("autopilot-run")) {
      return;
    }
    // 既存フックがある場合は後ろに追記するか、フックを安全に設定
    writeFileSync(preCommitPath, `${existing.trimEnd()}\n\n${hookContent}`);
  } else {
    writeFileSync(preCommitPath, hookContent);
  }
  chmodSync(preCommitPath, 0o755);
}
