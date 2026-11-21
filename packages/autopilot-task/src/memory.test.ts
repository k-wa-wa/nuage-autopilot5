import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMemory, rollbackFailedMemory, syncMemory, tailLines } from "./memory.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setupMemRepo(withOrigin = true): { root: string; repo: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "autopilot-task-mem-"));
  dir = root;
  const origin = join(root, "origin.git");
  const repo = join(root, "mem");
  if (withOrigin) {
    execFileSync("git", ["init", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", origin, repo]);
  } else {
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
  }
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "# memory\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  if (withOrigin) {
    git(repo, "push", "-u", "origin", "main");
  }
  return { root, repo, origin };
}

describe("tailLines", () => {
  test("末尾 N 行だけを取り出す", () => {
    expect(tailLines("", 5)).toBe("");
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(tailLines("1\n2\n3\n4\n", 10)).toBe("1\n2\n3\n4");
  });
});

describe("prepareMemory & syncMemory", () => {
  test("リモート無しでも警告にとどめて初期ファイルを作成し、追記分を commit できる", async () => {
    const { repo } = setupMemRepo(false);
    const warnings: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];

    const memory = { repo, file: "sub/task.md", maxLines: 3 };
    const prep = await prepareMemory(memory, { warn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(1);
    expect(existsSync(prep.filePath)).toBe(true);
    expect(prep.content).toBe("");

    writeFileSync(prep.filePath, "line1\nline2\nline3\nline4\n");
    const syncRes = await syncMemory(memory, "demo", {
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    });
    expect(errors).toEqual([]);
    expect(syncRes).toEqual({ ok: true, committed: true, pushed: false });
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("chore(memory): update demo");

    const prep2 = await prepareMemory(memory, { warn: (m) => warnings.push(m) });
    expect(prep2.content).toBe("line2\nline3\nline4");
  });

  test("変更が無ければ commit も push もせず成功する", async () => {
    const { repo } = setupMemRepo(true);
    const memory = { repo, file: "notes.md", maxLines: 200 };
    writeFileSync(join(repo, "notes.md"), "initial\n");
    git(repo, "add", "notes.md");
    git(repo, "commit", "-m", "add notes");
    git(repo, "push");

    const syncRes = await syncMemory(memory, "noop", { log: () => {}, error: () => {} });
    expect(syncRes).toEqual({ ok: true, committed: false, pushed: false });
  });

  test("origin があるときは pull --rebase --autostash の後に commit と push を行う", async () => {
    const { root, repo, origin } = setupMemRepo(true);
    const memory = { repo, file: "tasks/daily.md", maxLines: 200 };

    // 他者が先に別ファイルを push しておく
    const other = join(root, "other");
    execFileSync("git", ["clone", origin, other]);
    git(other, "config", "user.name", "other");
    git(other, "config", "user.email", "other@example.com");
    writeFileSync(join(other, "other.md"), "from other\n");
    git(other, "add", "other.md");
    git(other, "commit", "-m", "other commit");
    git(other, "push");

    mkdirSync(join(repo, "tasks"), { recursive: true });
    writeFileSync(join(repo, "tasks/daily.md"), "2026-11-22: ok\n");

    const syncRes = await syncMemory(memory, "daily", { log: () => {}, error: () => {} });
    expect(syncRes).toEqual({ ok: true, committed: true, pushed: true });
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("chore(memory): update daily");
    expect(readFileSync(join(repo, "other.md"), "utf8")).toBe("from other\n");
    expect(git(origin, "log", "-1", "--pretty=%s")).toBe("chore(memory): update daily");
  });

  test("rebase が衝突したら git rebase --abort で壊れた状態を残さずエラーを返す", async () => {
    const { root, repo, origin } = setupMemRepo(true);
    const memory = { repo, file: "conflict.md", maxLines: 200 };

    writeFileSync(join(repo, "conflict.md"), "base\n");
    git(repo, "add", "conflict.md");
    git(repo, "commit", "-m", "base");
    git(repo, "push");

    // 別クローンで同じファイルを更新して push
    const other = join(root, "other");
    execFileSync("git", ["clone", origin, other]);
    git(other, "config", "user.name", "other");
    git(other, "config", "user.email", "other@example.com");
    writeFileSync(join(other, "conflict.md"), "remote-change\n");
    git(other, "add", "conflict.md");
    git(other, "commit", "-m", "remote change");
    git(other, "push");

    // ローカルにも未 push の競合コミットと変更を置く
    writeFileSync(join(repo, "conflict.md"), "local-committed\n");
    git(repo, "add", "conflict.md");
    git(repo, "commit", "-m", "local commit");
    writeFileSync(join(repo, "conflict.md"), "local-change\n");

    const errors: string[] = [];
    const syncRes = await syncMemory(memory, "conflict-task", {
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(syncRes).toEqual({ ok: false, committed: false, pushed: false });
    expect(errors.length).toBeGreaterThan(0);
    // rebase 中の状態が残っていないこと
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);
    expect(existsSync(join(repo, ".git", "rebase-apply"))).toBe(false);
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("local commit");
  });

  test("autostash 適用で衝突した場合もコンフリクトマーカーをコミットせず中断する", async () => {
    const { root, repo, origin } = setupMemRepo(true);
    const memory = { repo, file: "conflict.md", maxLines: 200 };

    writeFileSync(join(repo, "conflict.md"), "base\n");
    git(repo, "add", "conflict.md");
    git(repo, "commit", "-m", "base");
    git(repo, "push");

    const other = join(root, "other");
    execFileSync("git", ["clone", origin, other]);
    git(other, "config", "user.name", "other");
    git(other, "config", "user.email", "other@example.com");
    writeFileSync(join(other, "conflict.md"), "remote-change\n");
    git(other, "add", "conflict.md");
    git(other, "commit", "-m", "remote change");
    git(other, "push");

    writeFileSync(join(repo, "conflict.md"), "local-uncommitted\n");

    const errors: string[] = [];
    const syncRes = await syncMemory(memory, "autostash-conflict", {
      log: () => {},
      error: (m) => errors.push(m),
    });

    expect(syncRes).toEqual({ ok: false, committed: false, pushed: false });
    expect(errors.some((e) => e.includes("autostash"))).toBe(true);
    expect(git(repo, "ls-files", "--unmerged")).toBe("");
    expect(git(repo, "log", "-1", "--pretty=%s")).toBe("remote change");
  });

  test("pre-commit フックが拒否したら unstage・作業ツリー復旧してエラーを返す", async () => {
    const { repo } = setupMemRepo(true);
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'secret blocked' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const memory = { repo, file: "secret.md", maxLines: 200 };
    writeFileSync(join(repo, "secret.md"), "bad-secret\n");
    const errors: string[] = [];
    const syncRes = await syncMemory(memory, "sec", {
      log: () => {},
      error: (m) => errors.push(m),
    });
    expect(syncRes).toEqual({ ok: false, committed: false, pushed: false });
    expect(errors.some((e) => e.includes("secret blocked"))).toBe(true);
    // 拒否された秘密情報がステージや作業ツリーに残らないこと
    expect(existsSync(join(repo, "secret.md"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  test("失敗時のロールバックは新規作成した空ファイルや途中の変更を元に戻す", async () => {
    const { repo } = setupMemRepo(false);
    const logs: string[] = [];
    const memNew = { repo, file: "new/mem.md", maxLines: 200 };
    const prepNew = await prepareMemory(memNew, { warn: () => {} });
    expect(prepNew.createdNew).toBe(true);
    writeFileSync(prepNew.filePath, "partial-dirty\n");
    rollbackFailedMemory(memNew, prepNew, { log: (m) => logs.push(m) });
    expect(existsSync(prepNew.filePath)).toBe(false);

    // 既存ファイルの途中変更も元へ戻る
    writeFileSync(join(repo, "existing.md"), "clean\n");
    git(repo, "add", "existing.md");
    git(repo, "commit", "-m", "add existing");
    const memOld = { repo, file: "existing.md", maxLines: 200 };
    const prepOld = await prepareMemory(memOld, { warn: () => {} });
    expect(prepOld.createdNew).toBe(false);
    writeFileSync(prepOld.filePath, "broken\n");
    rollbackFailedMemory(memOld, prepOld, { log: (m) => logs.push(m) });
    expect(readFileSync(prepOld.filePath, "utf8")).toBe("clean\n");
  });

  test("git ネットワーク操作がタイムアウトを超えたらハングせずエラーで抜ける", async () => {
    const { repo } = setupMemRepo(false);
    const binDir = join(repo, "..", "fake-git-bin");
    mkdirSync(binDir);
    const fakeGit = join(binDir, "git");
    const realGit = Bun.which("git") ?? "git";
    writeFileSync(
      fakeGit,
      `#!/bin/sh
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  status) echo "?? slow.md" ;;
  remote) echo "origin" ;;
  rev-parse) echo "origin/main" ;;
  pull) sleep 5 ;;
  *) exec ${realGit} "$@" ;;
esac
`,
    );
    chmodSync(fakeGit, 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;
    try {
      const errors: string[] = [];
      const res = await syncMemory({ repo, file: "slow.md", maxLines: 200 }, "slow", {
        log: () => {},
        error: (m) => errors.push(m),
        timeoutMs: 150,
      });
      expect(res).toEqual({ ok: false, committed: false, pushed: false });
      expect(errors.some((e) => e.includes("タイムアウト"))).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
