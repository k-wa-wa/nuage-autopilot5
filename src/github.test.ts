import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentBranch,
  defaultBranch,
  parseChecks,
  parseFailedRunId,
  parsePrNumber,
  resolveBaseSha,
} from "./github.ts";
import { GH_NO_AUTH, GH_NO_PR, git, tempRepo } from "./testing/helpers.ts";

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

describe("parsePrNumber", () => {
  test("成功なら番号を返す", () => {
    expect(parsePrNumber({ code: 0, stdout: "56", stderr: "" })).toBe(56);
  });

  test("PR が無いときだけ null を返す", () => {
    expect(parsePrNumber({ code: 1, stdout: "", stderr: GH_NO_PR })).toBeNull();
  });

  test("それ以外の失敗は gh の stderr を付けて例外にする", () => {
    expect(() => parsePrNumber({ code: 4, stdout: "", stderr: GH_NO_AUTH })).toThrow(
      /gh auth login/,
    );
    expect(() => parsePrNumber({ code: 1, stdout: "", stderr: "HTTP 502" })).toThrow(/HTTP 502/);
  });

  test("成功でも番号として読めなければ例外にする", () => {
    expect(() => parsePrNumber({ code: 0, stdout: "", stderr: "" })).toThrow(/gh pr view/);
  });
});

describe("parseFailedRunId", () => {
  test("該当する実行があれば ID、無ければ null", () => {
    expect(parseFailedRunId({ code: 0, stdout: "123", stderr: "" })).toBe("123");
    expect(parseFailedRunId({ code: 0, stdout: "", stderr: "" })).toBeNull();
  });

  test("gh の失敗は「見つからなかった」にせず、stderr を付けて例外にする", () => {
    expect(() => parseFailedRunId({ code: 4, stdout: "", stderr: GH_NO_AUTH })).toThrow(
      /gh run list.*gh auth login/s,
    );
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

  test("PR モードで gh repo view が失敗したら、origin/HEAD に落とさず stderr を付けて例外にする", async () => {
    repo = tempRepo();
    const bin = join(repo.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat >&2 <<'EOF'\n${GH_NO_AUTH}\nEOF\nexit 4\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await expect(defaultBranch(repo.work, false)).rejects.toThrow(/exit 4.*gh auth login/s);
    } finally {
      process.env.PATH = path;
    }
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
