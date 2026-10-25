import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { CheckBucket, PrSnapshot } from "./ci.ts";
import { capture } from "./exec.ts";

/**
 * GitHub とリポジトリの読み取り。gh と git の呼び出しはここだけに閉じる。
 * PR の作成や push はエージェントの仕事なので、ここは読むだけにする（PR 本文の更新も担当が行う）。
 */

/** PR と CI の読み取り。--local では使わない。 */
export interface GitHub {
  /** 現在のブランチの PR 番号。無ければ null。gh が失敗したら例外（「PR が無い」と区別する）。 */
  prNumber(): Promise<number | null>;
  /** PR の HEAD と CI の状態。読めなければ例外。 */
  snapshot(pr: number): Promise<PrSnapshot>;
  /** そのコミットで失敗した CI のログ末尾を保存する。gh が失敗したら例外。 */
  saveFailedLog(sha: string, path: string): Promise<void>;
}

const BUCKETS: readonly CheckBucket[] = ["pass", "fail", "pending", "skipping", "cancel"];

/**
 * `gh pr checks --json bucket` の結果を読む。
 * gh は実行中なら 8、失敗があれば 1 で終わることがあるので、終了コードではなく出力で判断する。
 * CI が 1 件も無いときは、出力が無く「no checks reported」で失敗する。
 */
export function parseChecks(r: { code: number; stdout: string; stderr: string }): CheckBucket[] {
  if (r.stdout.startsWith("[")) {
    const rows = JSON.parse(r.stdout) as { bucket?: string }[];
    return rows.map((row) => {
      const b = row.bucket as CheckBucket;
      if (!BUCKETS.includes(b)) throw new Error(`未知の CI 状態: ${row.bucket}`);
      return b;
    });
  }
  if (/no checks reported/i.test(r.stderr + r.stdout)) return [];
  throw new Error(`gh pr checks が失敗した (exit ${r.code}): ${r.stderr || r.stdout}`);
}

type GhResult = { code: number; stdout: string; stderr: string };

function ghFailed(what: string, r: GhResult): Error {
  return new Error(`${what} が失敗した (exit ${r.code}): ${r.stderr || r.stdout}`);
}

/**
 * `gh pr view --json number` の結果を読む。
 * PR が無いときも認証が無いときも gh は失敗で終わるので、stderr で見分ける。
 * 「PR が無い」以外の失敗を null にすると、認証エラーが「PR が作られなかった」に化ける。
 */
export function parsePrNumber(r: GhResult): number | null {
  if (r.code === 0) {
    const n = Number(r.stdout);
    if (Number.isInteger(n) && n > 0) return n;
  } else if (/no pull requests found/i.test(r.stderr)) {
    return null;
  }
  throw ghFailed("gh pr view", r);
}

/**
 * `gh run list` で選んだ、失敗した実行の ID を読む。該当する実行が無ければ null。
 * gh そのものの失敗は「見つからなかった」にしない。
 */
export function parseFailedRunId(r: GhResult): string | null {
  if (r.code !== 0) throw ghFailed("gh run list", r);
  return r.stdout || null;
}

export function realGitHub(cwd: string): GitHub {
  return {
    async prNumber() {
      return parsePrNumber(
        await capture(["gh", "pr", "view", "--json", "number", "-q", ".number"], cwd),
      );
    },

    async snapshot(pr) {
      const head = await capture(
        ["gh", "pr", "view", String(pr), "--json", "headRefOid", "-q", ".headRefOid"],
        cwd,
      );
      if (head.code !== 0 || !head.stdout) {
        throw new Error(`PR #${pr} を読めない: ${head.stderr}`);
      }
      const checks = await capture(["gh", "pr", "checks", String(pr), "--json", "bucket"], cwd);
      return { head: head.stdout, checks: parseChecks(checks) };
    },

    async saveFailedLog(sha, path) {
      const list = await capture(
        [
          "gh",
          "run",
          "list",
          "--commit",
          sha,
          "--json",
          "databaseId,conclusion",
          "-q",
          '[.[] | select(.conclusion=="failure")][0].databaseId',
        ],
        cwd,
      );
      const id = parseFailedRunId(list);
      let log = `コミット ${sha} の失敗した CI の実行が見つからなかった。gh pr checks で確認すること。`;
      if (id) {
        const view = await capture(["gh", "run", "view", id, "--log-failed"], cwd);
        if (view.code !== 0) throw ghFailed("gh run view", view);
        log = view.stdout;
      }
      writeFileSync(path, log.split("\n").slice(-200).join("\n"));
    },
  };
}

/**
 * 既定ブランチの名前。PR モードでは GitHub に、--local では origin/HEAD に聞く。
 * PR モードでは、この呼び出しで gh の認証とリポジトリへのアクセスも確かめる。
 * 失敗したら origin/HEAD に落とさず例外にする（PR を読めないまま実装を始めない）。
 */
export async function defaultBranch(cwd: string, local: boolean): Promise<string | null> {
  if (!local) {
    const r = await capture(
      ["gh", "repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
      cwd,
    );
    if (r.code !== 0 || !r.stdout) throw ghFailed("gh repo view", r);
    return r.stdout;
  }
  const r = await capture(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  return r.code === 0 && r.stdout ? r.stdout.replace(/^origin\//, "") : null;
}

/** 差分の起点。origin の既定ブランチとの分岐点。 */
export async function resolveBaseSha(cwd: string, branch: string | null): Promise<string> {
  const candidates: string[] = [];
  if (branch) {
    await capture(["git", "fetch", "origin", branch], cwd);
    candidates.push(`origin/${branch}`);
  }
  candidates.push("origin/HEAD", "origin/main", "origin/master");
  for (const ref of candidates) {
    const r = await capture(["git", "merge-base", "HEAD", ref], cwd);
    if (r.code === 0 && r.stdout) return r.stdout;
  }
  throw new Error("差分の起点（既定ブランチ）が見つからない");
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await capture(["git", "branch", "--show-current"], cwd)).stdout;
}

export async function headSha(cwd: string): Promise<string> {
  return (await capture(["git", "rev-parse", "HEAD"], cwd)).stdout;
}

/**
 * 作業ツリーの状態を表す値。HEAD・未 commit の変更・未追跡のファイルのどれかが変われば変わる。
 * .autopilot/ は exclude しているので含まない。
 */
export async function worktreeFingerprint(cwd: string): Promise<string> {
  const parts = await Promise.all([
    capture(["git", "rev-parse", "HEAD"], cwd),
    capture(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd),
    capture(["git", "diff", "HEAD"], cwd),
  ]);
  const hash = createHash("sha256");
  for (const p of parts) hash.update(`${p.stdout}\0`);
  return hash.digest("hex");
}

/** git の共通ディレクトリ（worktree でも本体の .git を指す）。 */
export async function gitCommonDir(cwd: string): Promise<string> {
  return (await capture(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd))
    .stdout;
}

export async function gitToplevel(cwd: string): Promise<string | null> {
  const r = await capture(["git", "rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 ? r.stdout : null;
}
