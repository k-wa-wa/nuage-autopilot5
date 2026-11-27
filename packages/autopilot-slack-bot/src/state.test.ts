import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadSessionStore } from "./state.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe("ThreadSessionStore", () => {
  test("スレッド単位の状態を永続化・復元できる", () => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-slack-state-"));
    const store = new ThreadSessionStore(dir, "bot-a");

    expect(store.hasParticipated("C01", "100.1")).toBe(false);
    expect(store.get("C01", "100.1")).toBeNull();

    store.save({
      botName: "bot-a",
      channel: "C01",
      threadTs: "100.1",
      participated: true,
      agent: "claude",
      model: "m1",
      effort: "high",
      sessionId: "sess-123",
      lastProcessedTs: "100.2",
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:01:00.000Z",
    });

    expect(store.hasParticipated("C01", "100.1")).toBe(true);
    expect(store.hasParticipated("C01", "200.1")).toBe(false);

    // 別インスタンスから再読み込みしても復元できる
    const store2 = new ThreadSessionStore(dir, "bot-a");
    expect(store2.get("C01", "100.1")).toEqual({
      botName: "bot-a",
      channel: "C01",
      threadTs: "100.1",
      participated: true,
      agent: "claude",
      model: "m1",
      effort: "high",
      sessionId: "sess-123",
      lastProcessedTs: "100.2",
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:01:00.000Z",
    });
  });

  test("壊れた状態ファイルがあっても null を返して落ちない", () => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-slack-state-"));
    const store = new ThreadSessionStore(dir, "bot-a");
    store.save({
      botName: "bot-a",
      channel: "C01",
      threadTs: "100.1",
      participated: true,
      agent: "agy",
      sessionId: "s1",
      lastProcessedTs: "100.1",
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
    });
    const [file] = Array.from(new Bun.Glob("*.json").scanSync(store.dir));
    writeFileSync(join(store.dir, file!), "{broken");
    expect(store.get("C01", "100.1")).toBeNull();
  });
});
