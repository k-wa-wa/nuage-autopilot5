import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { State } from "./state.ts";
import { tempDir } from "./testing/helpers.ts";

describe("State", () => {
  let dir: ReturnType<typeof tempDir>;
  afterEach(() => dir.cleanup());

  test("stage は status を置き換え、run.log に追記する", () => {
    dir = tempDir();
    const s = new State(dir.path);
    s.stage("implementing");
    s.stage("done");
    expect(s.status()).toBe("done");
    expect(s.read("run.log")).toMatch(/== implementing\n.*== done\n$/);
  });

  test("status が無ければ - を返す", () => {
    dir = tempDir();
    expect(new State(dir.path).status()).toBe("-");
  });

  test("追加指示はラウンドごとの名前に退避し、二度読ませない", () => {
    dir = tempDir();
    const s = new State(dir.path);
    expect(s.takeInbox(1)).toBeNull();
    writeFileSync(s.file("inbox.md"), "テストも足して\n");
    expect(s.takeInbox(1)).toBe("inbox-1.md");
    expect(s.read("inbox-1.md")).toBe("テストも足して\n");
    expect(existsSync(s.file("inbox.md"))).toBe(false);
    expect(s.takeInbox(2)).toBeNull();
  });

  test("空の inbox.md は追加指示として扱わない", () => {
    dir = tempDir();
    const s = new State(dir.path);
    writeFileSync(s.file("inbox.md"), "");
    expect(s.takeInbox(1)).toBeNull();
  });

  test("run.pid のプロセスが生きているときだけ実行中とみなす", () => {
    dir = tempDir();
    const s = new State(dir.path);
    expect(s.runningPid()).toBeNull();
    writeFileSync(s.file("run.pid"), String(process.pid));
    expect(s.runningPid()).toBe(process.pid);
    // 落ちたプロセスの残骸
    writeFileSync(s.file("run.pid"), "9999999");
    expect(s.runningPid()).toBeNull();
    writeFileSync(s.file("run.pid"), "garbage");
    expect(s.runningPid()).toBeNull();
  });

  test("rel は worktree からの相対パス（プロンプトに書く用）", () => {
    dir = tempDir();
    expect(new State(dir.path).rel("brief.md")).toBe(".autopilot/brief.md");
  });
});
