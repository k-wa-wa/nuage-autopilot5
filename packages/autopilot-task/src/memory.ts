import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "../../autopilot-run/src/exec.ts";
import type { TaskMemory } from "./config.ts";

/** テキストの末尾 maxLines 行を返す。 */
export function tailLines(text: string, maxLines: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

/** 記憶リポジトリを確認・最新化し、対象ファイルが無ければ初期作成して末尾 maxLines 行を読む。 */
export async function prepareMemory(
  memory: TaskMemory,
  opts: { warn: (msg: string) => void },
): Promise<{ filePath: string; content: string }> {
  if (!existsSync(memory.repo) || !statSync(memory.repo).isDirectory()) {
    throw new Error(`memory.repo ディレクトリが存在しない: ${memory.repo}`);
  }
  const inside = await capture(
    ["git", "-C", memory.repo, "rev-parse", "--is-inside-work-tree"],
    memory.repo,
  );
  if (inside.code !== 0 || inside.stdout !== "true") {
    throw new Error(`memory.repo が git リポジトリではない: ${memory.repo}`);
  }

  const pull = await capture(["git", "-C", memory.repo, "pull", "--ff-only"], memory.repo);
  if (pull.code !== 0) {
    opts.warn(
      `memory.repo の git pull --ff-only に失敗したためそのまま続行する: ${pull.stderr || pull.stdout}`,
    );
  }

  const filePath = join(memory.repo, memory.file);
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "");
  }
  const raw = readFileSync(filePath, "utf8");
  return { filePath, content: tailLines(raw, memory.maxLines) };
}

export interface SyncMemoryResult {
  ok: boolean;
  committed: boolean;
  pushed: boolean;
}

/** 記憶ファイルの変更を pull --rebase --autostash → commit → push する。 */
export async function syncMemory(
  memory: TaskMemory,
  taskName: string,
  opts: { log: (msg: string) => void; error: (msg: string) => void },
): Promise<SyncMemoryResult> {
  const status = await capture(
    [
      "git",
      "-C",
      memory.repo,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      memory.file,
    ],
    memory.repo,
    { trim: false },
  );
  if (status.code !== 0) {
    opts.error(`memory.repo の git status に失敗した: ${status.stderr}`);
    return { ok: false, committed: false, pushed: false };
  }
  if (status.stdout.trim().length === 0) {
    return { ok: true, committed: false, pushed: false };
  }

  const originCheck = await capture(
    ["git", "-C", memory.repo, "remote", "get-url", "origin"],
    memory.repo,
  );
  const hasOrigin = originCheck.code === 0;
  const upstreamCheck = hasOrigin
    ? await capture(
        ["git", "-C", memory.repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        memory.repo,
      )
    : { code: 1, stdout: "", stderr: "" };
  const hasUpstream = upstreamCheck.code === 0;

  if (hasOrigin) {
    let pullArgs: string[] | null = null;
    if (hasUpstream) {
      pullArgs = ["git", "-C", memory.repo, "pull", "--rebase", "--autostash"];
    } else {
      const branchRes = await capture(
        ["git", "-C", memory.repo, "branch", "--show-current"],
        memory.repo,
      );
      const branch = branchRes.stdout;
      if (branch) {
        const remoteHead = await capture(
          ["git", "-C", memory.repo, "ls-remote", "--heads", "origin", branch],
          memory.repo,
        );
        if (remoteHead.code === 0 && remoteHead.stdout.length > 0) {
          pullArgs = [
            "git",
            "-C",
            memory.repo,
            "pull",
            "--rebase",
            "--autostash",
            "origin",
            branch,
          ];
        }
      }
    }

    if (pullArgs) {
      const pullRes = await capture(pullArgs, memory.repo);
      if (pullRes.code !== 0) {
        await capture(["git", "-C", memory.repo, "rebase", "--abort"], memory.repo);
        opts.error(
          `memory.repo の git pull --rebase --autostash に失敗したため commit/push を中断した: ${pullRes.stderr || pullRes.stdout}`,
        );
        return { ok: false, committed: false, pushed: false };
      }
      // pull --rebase --autostash は autostash 適用衝突時に exit 0 で unmerged を残す場合がある
      const unmerged = await capture(
        ["git", "-C", memory.repo, "ls-files", "--unmerged"],
        memory.repo,
      );
      if (unmerged.code !== 0 || unmerged.stdout.trim().length > 0) {
        await capture(["git", "-C", memory.repo, "reset", "--merge"], memory.repo);
        opts.error(
          `memory.repo の autostash 適用で衝突が発生したため commit/push を中断した（変更は stash に退避済み）: ${unmerged.stdout}`,
        );
        return { ok: false, committed: false, pushed: false };
      }
    }
  }

  const addRes = await capture(["git", "-C", memory.repo, "add", "--", memory.file], memory.repo);
  if (addRes.code !== 0) {
    opts.error(`memory.repo の git add に失敗した: ${addRes.stderr || addRes.stdout}`);
    return { ok: false, committed: false, pushed: false };
  }

  const diffRes = await capture(
    ["git", "-C", memory.repo, "diff", "--cached", "--quiet", "--", memory.file],
    memory.repo,
  );
  if (diffRes.code === 0) {
    return { ok: true, committed: false, pushed: false };
  }
  if (diffRes.code !== 1) {
    opts.error(`memory.repo の git diff --cached に失敗した: ${diffRes.stderr}`);
    return { ok: false, committed: false, pushed: false };
  }

  const commitRes = await capture(
    ["git", "-C", memory.repo, "commit", "-m", `chore(memory): update ${taskName}`],
    memory.repo,
  );
  if (commitRes.code !== 0) {
    opts.error(`memory.repo の git commit に失敗した: ${commitRes.stderr || commitRes.stdout}`);
    return { ok: false, committed: false, pushed: false };
  }
  opts.log(`記憶をコミットした: ${memory.file}`);

  if (hasOrigin) {
    const pushArgs = hasUpstream
      ? ["git", "-C", memory.repo, "push"]
      : ["git", "-C", memory.repo, "push", "-u", "origin", "HEAD"];
    const pushRes = await capture(pushArgs, memory.repo);
    if (pushRes.code !== 0) {
      opts.error(`memory.repo の git push に失敗した: ${pushRes.stderr || pushRes.stdout}`);
      return { ok: false, committed: true, pushed: false };
    }
    opts.log(`記憶を push した: ${memory.file}`);
  }

  return { ok: true, committed: true, pushed: hasOrigin };
}
