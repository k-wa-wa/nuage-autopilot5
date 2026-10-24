import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentBranch, defaultBranch, parseChecks, resolveBaseSha } from "./github.ts";
import { git, tempRepo } from "./testing/helpers.ts";

describe("parseChecks", () => {
  test("gh pr checks --json bucket の結果を読む", () => {
    const stdout = JSON.stringify([
      { bucket: "pass" },
      { bucket: "skipping" },
      { bucket: "pending" },
    ]);
    expect(parseChecks({ code: 0, stdout, stderr: "" })).toEqual(["pass", "skipping", "pending"]);
  });

  test("実行中（8）や失敗（1）で終わっても、出力があればそれを読む", () => {
    const pending = JSON.stringify([{ bucket: "pending" }]);
    const failed = JSON.stringify([{ bucket: "fail" }]);
    expect(parseChecks({ code: 8, stdout: pending, stderr: "" })).toEqual(["pending"]);
    expect(parseChecks({ code: 1, stdout: failed, stderr: "" })).toEqual(["fail"]);
  });

  test("CI が 1 件も無いときは、gh が失敗で終わっても空として読む", () => {
    expect(
      parseChecks({ code: 1, stdout: "", stderr: "no checks reported on the 'feat/x' branch" }),
    ).toEqual([]);
  });

  test("それ以外の失敗は握りつぶさない", () => {
    expect(() => parseChecks({ code: 1, stdout: "", stderr: "HTTP 502" })).toThrow(/HTTP 502/);
  });

  test("知らない状態は握りつぶさない（gh の仕様変更に気づくため）", () => {
    expect(() =>
      parseChecks({ code: 0, stdout: JSON.stringify([{ bucket: "weird" }]), stderr: "" }),
    ).toThrow(/weird/);
  });
});

describe("git の読み取り", () => {
  let repo: ReturnType<typeof tempRepo>;
  afterEach(() => repo.cleanup());

  test("--local の既定ブランチは origin/HEAD から読む", async () => {
    repo = tempRepo();
    expect(await defaultBranch(repo.work, true)).toBe("main");
    expect(await currentBranch(repo.work)).toBe("feat/x");
  });

  test("差分の起点は既定ブランチとの分岐点（作業ブランチの commit を含まない）", async () => {
    repo = tempRepo();
    const fork = git(repo.work, "rev-parse", "HEAD");
    writeFileSync(join(repo.work, "a.txt"), "a\n");
    git(repo.work, "add", "-A");
    git(repo.work, "commit", "-qm", "a");
    expect(await resolveBaseSha(repo.work, "main")).toBe(fork);
  });

  test("既定ブランチが分からなくても origin/HEAD などで起点を探す", async () => {
    repo = tempRepo();
    expect(await resolveBaseSha(repo.work, null)).toBe(git(repo.work, "rev-parse", "HEAD"));
  });
});
