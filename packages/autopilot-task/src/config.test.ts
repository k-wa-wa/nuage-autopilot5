import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTaskConfig, parseTaskConfig } from "./config.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function setupSoul(): { root: string; soul: string } {
  dir = mkdtempSync(join(tmpdir(), "autopilot-task-cfg-"));
  const soul = join(dir, "SOUL.md");
  writeFileSync(soul, "# Task Soul\nDo something useful.\n");
  return { root: dir, soul };
}

describe("parseTaskConfig", () => {
  test("最小限の設定に既定値を補って正規化する", () => {
    const { soul } = setupSoul();
    const cfg = parseTaskConfig(
      JSON.stringify({
        name: "daily-report_1",
        soulFile: soul,
        trigger: { type: "cron", schedule: "hourly" },
      }),
    );
    expect(cfg).toEqual({
      name: "daily-report_1",
      soulFile: soul,
      agent: null,
      level: "standard",
      trigger: { type: "cron", schedule: "hourly" },
      precheck: null,
      memory: null,
      workdir: null,
      timeoutSec: 3600,
    });
  });

  test("すべてのオプションを指定した設定を読む", () => {
    const { root, soul } = setupSoul();
    const cfg = parseTaskConfig(
      JSON.stringify({
        name: "triage.weekly",
        soulFile: soul,
        agent: "codex",
        level: "high",
        trigger: { type: "cron", schedule: "Mon *-*-* 09:00:00" },
        precheck: { command: "test -f flag", timeoutSec: 15 },
        memory: { repo: join(root, "mem"), file: "notes/triage.md", maxLines: 50 },
        workdir: join(root, "work"),
        timeoutSec: 900,
      }),
    );
    expect(cfg.agent).toBe("codex");
    expect(cfg.level).toBe("high");
    expect(cfg.precheck).toEqual({ command: "test -f flag", timeoutSec: 15 });
    expect(cfg.memory).toEqual({
      repo: join(root, "mem"),
      file: "notes/triage.md",
      maxLines: 50,
    });
    expect(cfg.workdir).toBe(join(root, "work"));
    expect(cfg.timeoutSec).toBe(900);
  });

  test("不正な name・soulFile・memory・未知のキーを拒否する", () => {
    const { root, soul } = setupSoul();
    const valid = {
      name: "ok",
      soulFile: soul,
      trigger: { type: "cron", schedule: "daily" },
    };

    expect(() => parseTaskConfig("{not json")).toThrow(/JSON/);
    expect(() => parseTaskConfig("[]")).toThrow(/JSON オブジェクト/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, extra: 1 }))).toThrow(/未知の項目/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, name: "" }))).toThrow(/name/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, name: "../bad" }))).toThrow(/name/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, name: "a/b" }))).toThrow(/name/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, soulFile: "SOUL.md" }))).toThrow(
      /絶対パス/,
    );
    expect(() =>
      parseTaskConfig(JSON.stringify({ ...valid, soulFile: join(root, "missing.md") })),
    ).toThrow(/見つからない/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, soulFile: root }))).toThrow(
      /見つからない/,
    );
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, agent: "unknown" }))).toThrow(/agent/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, level: "ultra" }))).toThrow(/level/);
    expect(() =>
      parseTaskConfig(JSON.stringify({ ...valid, trigger: { type: "webhook", schedule: "*" } })),
    ).toThrow(/trigger\.type/);
    expect(() =>
      parseTaskConfig(JSON.stringify({ ...valid, precheck: { command: "true", timeoutSec: 0 } })),
    ).toThrow(/precheck\.timeoutSec/);
    expect(() =>
      parseTaskConfig(
        JSON.stringify({
          ...valid,
          memory: { repo: join(root, "mem"), file: "../escape.md" },
        }),
      ),
    ).toThrow(/リポジトリ外/);
    expect(() =>
      parseTaskConfig(
        JSON.stringify({
          ...valid,
          memory: { repo: join(root, "mem"), file: "/abs.md" },
        }),
      ),
    ).toThrow(/相対パス/);
    expect(() =>
      parseTaskConfig(
        JSON.stringify({
          ...valid,
          memory: { repo: join(root, "mem"), file: "a.md", maxLines: 1.5 },
        }),
      ),
    ).toThrow(/maxLines/);
    expect(() => parseTaskConfig(JSON.stringify({ ...valid, timeoutSec: -1 }))).toThrow(
      /timeoutSec/,
    );
  });
});

describe("loadTaskConfig", () => {
  test("ファイルから読み込み、ディレクトリや不在ファイルは拒否する", () => {
    const { root, soul } = setupSoul();
    const cfgPath = join(root, "task.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        name: "sample",
        soulFile: soul,
        trigger: { type: "cron", schedule: "daily" },
      }),
    );
    expect(loadTaskConfig(cfgPath).name).toBe("sample");
    mkdirSync(join(root, "sub"));
    expect(() => loadTaskConfig(join(root, "sub"))).toThrow(/見つからない/);
    expect(() => loadTaskConfig(join(root, "none.json"))).toThrow(/見つからない/);
  });
});
