import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { capture } from "./exec.ts";

/**
 * 機密情報漏洩防止（Secret Shield）モジュール。
 *
 * 1. Git pre-commit フック:
 *    - 未暗号化 SOPS ファイル（secrets*.yaml 等の平文コミット、sops_mac 不在）を検査
 *    - gitleaks git --staged でステージされた差分を検査
 *    - リポジトリ既存のローカルフックがあれば連鎖実行
 * 2. gh セーフラッパー:
 *    - gh pr create/edit/comment/review, gh issue create/edit/comment, gh api のテキスト引数を抽出
 *    - stdin は -F -, --body-file -, --input - 等で明示された場合のみ読み込み（読み取り系のハング防止）
 *    - gitleaks stdin で機密情報をスキャン
 *    - 機密情報検知時は exit 1 でブロック（本物の gh は呼ばない）
 *    - 機密情報なし／読み取りコマンドは本物の gh に透過転送
 */

/**
 * リポジトリの .sops.yaml から path_regex 一覧を読み取る。
 */
export function loadSopsPathRegexes(cwd: string): RegExp[] {
  let dir = resolve(cwd);
  while (true) {
    for (const name of [".sops.yaml", ".sops.yml"]) {
      const p = join(dir, name);
      if (existsSync(p)) {
        try {
          const content = readFileSync(p, "utf8");
          const regexes: RegExp[] = [];
          for (const line of content.split("\n")) {
            const m = line.match(/path_regex\s*:\s*["']?([^"'\s]+)["']?/);
            if (m?.[1]) {
              try {
                regexes.push(new RegExp(m[1]));
              } catch {
                // 無効な正規表現はスキップ
              }
            }
          }
          if (regexes.length > 0) return regexes;
        } catch {
          // 読み取り失敗時はフォールバック
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

/** SOPS 暗号化対象となるファイルパスパターンか判定。 */
export function isSopsCandidateFile(filePath: string, cwd: string = process.cwd()): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  // 設定ファイル自体は除外
  if (base === ".sops.yaml" || base === ".sops.yml") return false;

  // .sops.yaml が存在する場合はその path_regex を最優先で使う
  const sopsRegexes = loadSopsPathRegexes(cwd);
  if (sopsRegexes.length > 0) {
    return sopsRegexes.some((re) => re.test(filePath));
  }

  // 非 SOPS の明らかな例外（K8s Secret マニフェスト、ダミー用 local-secrets など）を除外
  if (/local-secrets/i.test(base)) return false;
  if (/-secret-appset\./i.test(base)) return false;
  if (base === "secret.yaml" || base === "secret.yml") return false;
  if (/notifications-secret\./i.test(base)) return false;

  // secrets*.yaml, *.secrets.yaml, secrets/*.yaml
  return (
    /(?:^|\/)secrets[^/]*\.(?:ya?ml|json)$/i.test(filePath) ||
    /(?:^|\/)[^/]*\.secrets\.(?:ya?ml|json)$/i.test(filePath)
  );
}

/** 内容が SOPS で暗号化されているか判定（sops_mac または sops.mac: ENC[...] の存在）。 */
export function isEncryptedSops(content: string): boolean {
  // sops:allow コメントがある場合は許可
  if (/sops:allow/i.test(content)) return true;
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
 * 名前変更（R）も含め、-z で NUL 区切りにより日本語等のクォートパスも正確に処理する。
 */
export async function checkUnencryptedSops(cwd: string = process.cwd()): Promise<SopsCheckResult> {
  const staged = await capture(
    ["git", "diff", "--cached", "-z", "--name-only", "--diff-filter=ACMR"],
    cwd,
  );
  if (staged.code !== 0) {
    return { ok: false, reason: `git diff --cached failed: ${staged.stderr}` };
  }
  const files = staged.stdout.split("\0").filter(Boolean);

  for (const file of files) {
    if (!isSopsCandidateFile(file, cwd)) continue;
    const contentRes = await capture(["git", "show", `:${file}`], cwd);
    if (contentRes.code !== 0) {
      return {
        ok: false,
        file,
        reason: `git show :${file} failed: ${contentRes.stderr}`,
      };
    }
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

  const proc = Bun.spawn(
    ["gitleaks", "stdin", "--verbose", "--no-banner", "--redact", "--exit-code", "1"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  proc.stdin.write(text);
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 1) {
    const detail = (stderr || stdout).trim();
    return {
      ok: false,
      reason: "テキスト内に機密情報が検知されました",
      detail,
    };
  }

  if (exitCode !== 0) {
    const detail = (stderr || stdout).trim();
    return {
      ok: false,
      reason: `gitleaks の実行に失敗しました (exit ${exitCode})`,
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

  const proc = Bun.spawn(
    ["gitleaks", "git", "--staged", "--verbose", "--no-banner", "--redact", "--exit-code", "1"],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode === 1) {
    const detail = (stderr || stdout).trim();
    return {
      ok: false,
      reason: "ステージされた変更内に機密情報が検知されました",
      detail,
    };
  }

  if (exitCode !== 0) {
    const detail = (stderr || stdout).trim();
    return {
      ok: false,
      reason: `gitleaks の実行に失敗しました (exit ${exitCode})`,
      detail,
    };
  }

  return { ok: true };
}

export interface ExtractResult {
  shouldScan: boolean;
  needsStdin: boolean;
  texts: string[];
}

function parseField(
  val: string,
  isTyped: boolean,
  stdinText?: string,
): { texts: string[]; needsStdin: boolean } {
  const texts: string[] = [val];
  let needsStdin = false;
  if (isTyped) {
    const eq = val.indexOf("=");
    if (eq !== -1) {
      const rhs = val.slice(eq + 1);
      if (rhs === "@-") {
        needsStdin = true;
        if (stdinText) texts.push(stdinText);
      } else if (rhs.startsWith("@")) {
        const p = rhs.slice(1);
        if (existsSync(p)) {
          try {
            texts.push(readFileSync(p, "utf8"));
          } catch {
            // 読み取り不可時はスキップ
          }
        }
      }
    }
  }
  return { texts, needsStdin };
}

/**
 * gh コマンドライン引数から、スキャン対象のテキストを抽出する。
 */
export function extractGhTexts(args: string[], stdinText?: string): ExtractResult {
  // フラグ以外の位置引数を集めてコマンドを特定
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      // 値を取るフラグ（引数分割型）をスキップ
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
          "--raw-field",
          "-X",
          "--method",
          "--input",
          "-H",
          "--header",
          "-q",
          "--jq",
          "-u",
          "--url",
          "-p",
          "--preview",
        ].includes(arg)
      ) {
        i++;
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
    "pr review",
    "issue create",
    "issue edit",
    "issue comment",
  ].includes(cmd);
  const isApi = positional[0] === "api";

  if (!isPrOrIssue && !isApi) {
    return { shouldScan: false, needsStdin: false, texts: [] };
  }

  const texts: string[] = [];
  let needsStdin = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (isPrOrIssue) {
      // -t, --title
      if (arg === "-t" || arg === "--title") {
        if (i + 1 < args.length) texts.push(args[++i]!);
      } else if (arg.startsWith("-t=") || arg.startsWith("--title=")) {
        texts.push(arg.slice(arg.indexOf("=") + 1));
      } else if (arg.startsWith("-t") && arg.length > 2) {
        texts.push(arg.slice(2));
      }
      // -b, --body
      else if (arg === "-b" || arg === "--body") {
        if (i + 1 < args.length) texts.push(args[++i]!);
      } else if (arg.startsWith("-b=") || arg.startsWith("--body=")) {
        texts.push(arg.slice(arg.indexOf("=") + 1));
      } else if (arg.startsWith("-b") && arg.length > 2) {
        texts.push(arg.slice(2));
      }
      // -F, --body-file
      else if (arg === "-F" || arg === "--body-file") {
        if (i + 1 < args.length) {
          const filePath = args[++i]!;
          if (filePath === "-") {
            needsStdin = true;
            if (stdinText) texts.push(stdinText);
          } else if (existsSync(filePath)) {
            texts.push(readFileSync(filePath, "utf8"));
          }
        }
      } else if (arg.startsWith("-F=") || arg.startsWith("--body-file=")) {
        const filePath = arg.slice(arg.indexOf("=") + 1);
        if (filePath === "-") {
          needsStdin = true;
          if (stdinText) texts.push(stdinText);
        } else if (existsSync(filePath)) {
          texts.push(readFileSync(filePath, "utf8"));
        }
      } else if (arg.startsWith("-F") && arg.length > 2) {
        const filePath = arg.slice(2);
        if (filePath === "-") {
          needsStdin = true;
          if (stdinText) texts.push(stdinText);
        } else if (existsSync(filePath)) {
          texts.push(readFileSync(filePath, "utf8"));
        }
      }
    } else if (isApi) {
      // -f, --raw-field (静的文字列パラメータ: key=val)
      if (arg === "-f" || arg === "--raw-field") {
        if (i + 1 < args.length) texts.push(args[++i]!);
      } else if (arg.startsWith("-f=") || arg.startsWith("--raw-field=")) {
        texts.push(arg.slice(arg.indexOf("=") + 1));
      } else if (arg.startsWith("-f") && arg.length > 2) {
        texts.push(arg.slice(2));
      }
      // -F, --field (型付き・ファイル・stdin パラメータ: key=val, key=@file, key=@-)
      else if (arg === "-F" || arg === "--field") {
        if (i + 1 < args.length) {
          const r = parseField(args[++i]!, true, stdinText);
          texts.push(...r.texts);
          if (r.needsStdin) needsStdin = true;
        }
      } else if (arg.startsWith("-F=") || arg.startsWith("--field=")) {
        const val = arg.slice(arg.indexOf("=") + 1);
        const r = parseField(val, true, stdinText);
        texts.push(...r.texts);
        if (r.needsStdin) needsStdin = true;
      } else if (arg.startsWith("-F") && arg.length > 2) {
        const val = arg.slice(2);
        const r = parseField(val, true, stdinText);
        texts.push(...r.texts);
        if (r.needsStdin) needsStdin = true;
      }
      // --input
      else if (arg === "--input") {
        if (i + 1 < args.length) {
          const p = args[++i]!;
          if (p === "-") {
            needsStdin = true;
            if (stdinText) texts.push(stdinText);
          } else if (existsSync(p)) {
            texts.push(readFileSync(p, "utf8"));
          }
        }
      } else if (arg.startsWith("--input=")) {
        const p = arg.slice(arg.indexOf("=") + 1);
        if (p === "-") {
          needsStdin = true;
          if (stdinText) texts.push(stdinText);
        } else if (existsSync(p)) {
          texts.push(readFileSync(p, "utf8"));
        }
      }
    }
  }

  return { shouldScan: true, needsStdin, texts };
}

/**
 * pre-commit フックの実行。
 * 自走の検査（SOPS + gitleaks）を実行後、リポジトリローカルの既存フックがあれば連鎖実行する。
 */
export async function runPreCommit(
  cwd: string = process.cwd(),
  hookArgs: string[] = [],
): Promise<number> {
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

  // リポジトリ側の既存 pre-commit フック（husky, pre-commit framework 等）があれば連鎖実行
  // core.hooksPath が設定されている場合でも本来のリポジトリ側フックを見つけるため --git-common-dir から探す
  const commonDirRes = await capture(["git", "rev-parse", "--git-common-dir"], cwd);
  if (commonDirRes.code === 0 && commonDirRes.stdout.trim()) {
    const commonDir = commonDirRes.stdout.trim();
    const localHook = resolve(cwd, commonDir, "hooks", "pre-commit");
    if (existsSync(localHook)) {
      let isSelf = false;
      try {
        const hookReal = realpathSync(localHook);
        const selfExec = realpathSync(process.execPath);
        if (hookReal === selfExec || hookReal.includes("autopilot5/hooks/pre-commit")) {
          isSelf = true;
        }
      } catch {
        // パス解決失敗時は内容で判定
      }

      let content = "";
      try {
        content = readFileSync(localHook, "utf8");
      } catch {
        // 読み取り失敗
      }

      if (
        content.includes("autopilot secret-shield pre-commit hook") ||
        content.includes("autopilot-run shield pre-commit")
      ) {
        isSelf = true;
      }

      if (!isSelf) {
        const child = Bun.spawn([localHook, ...hookArgs], {
          cwd,
          stdio: ["inherit", "inherit", "inherit"],
        });
        const code = await child.exited;
        if (code !== 0) return code;
      }
    }
  }

  return 0;
}

/** 本物の gh のパスを取得する（無限再帰を防ぐ）。 */
export function resolveRealGh(): string {
  if (process.env.GH_REAL_PATH && existsSync(process.env.GH_REAL_PATH)) {
    return process.env.GH_REAL_PATH;
  }
  const pathDirs = (process.env.PATH || "").split(":");
  const currentScript = process.argv[1] ? resolve(process.argv[1]) : "";
  for (const dir of pathDirs) {
    const candidate = join(dir, "gh");
    if (existsSync(candidate)) {
      try {
        const real = resolve(candidate);
        if (real !== currentScript && !candidate.includes("autopilot")) {
          return candidate;
        }
      } catch {
        // resolve 失敗はスキップ
      }
    }
  }
  throw new Error("本物の gh が見つかりません。GH_REAL_PATH を設定してください。");
}

/**
 * gh セーフラッパーの実行。
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
 * システム設定（core.hooksPath）が無い環境でのフォールバックとして配置する。
 */
export async function ensureGitHooks(gitDir: string): Promise<void> {
  // システムまたはローカルで core.hooksPath が既に設定されている場合は何もしない
  const check = await capture(["git", "config", "core.hooksPath"], dirname(gitDir));
  if (check.code === 0 && check.stdout.trim()) {
    return;
  }

  const hooksDir = join(gitDir, "hooks");
  const preCommitPath = join(hooksDir, "pre-commit");
  mkdirSync(hooksDir, { recursive: true });

  const currentScript = process.argv[1] ? resolve(process.argv[1]) : "";
  const execPath = process.execPath;
  const hookContent = `#!/bin/sh
# autopilot secret-shield pre-commit hook
if command -v autopilot-run >/dev/null 2>&1; then
  exec autopilot-run shield pre-commit "$@"
elif [ -f "${currentScript}" ]; then
  exec "${execPath}" "${currentScript}" shield pre-commit "$@"
fi
echo "[secret-shield] autopilot-run not found in PATH" >&2
exit 1
`;

  if (existsSync(preCommitPath)) {
    const existing = readFileSync(preCommitPath, "utf8");
    if (existing.includes("shield pre-commit") || existing.includes("autopilot-run")) {
      return;
    }
    // 既存フックがある場合は連鎖できるように先頭に挿入
    writeFileSync(preCommitPath, `${hookContent}\n${existing}`);
  } else {
    writeFileSync(preCommitPath, hookContent);
  }
  chmodSync(preCommitPath, 0o755);
}
