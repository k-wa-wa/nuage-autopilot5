import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSlackBotConfig,
  normalizeApiBaseUrl,
  parseSlackBotConfig,
  resolveSlackRuntimeEnv,
} from "./config.ts";

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function setupSoul(): { root: string; soul: string } {
  dir = mkdtempSync(join(tmpdir(), "autopilot-slack-cfg-"));
  const soul = join(dir, "SOUL.md");
  writeFileSync(soul, "# Slack Bot Soul\nエラー通知を調査すること。\n");
  return { root: dir, soul };
}

describe("parseSlackBotConfig", () => {
  test("最小限の設定に既定値を補って正規化する", () => {
    const { soul } = setupSoul();
    const cfg = parseSlackBotConfig(
      JSON.stringify({
        name: "alert-investigator_1",
        soulFile: soul,
      }),
    );
    expect(cfg).toEqual({
      name: "alert-investigator_1",
      soulFile: soul,
      agent: null,
      level: "standard",
      apiBaseUrl: null,
      workdir: null,
      timeoutSec: 3600,
      concurrency: 3,
    });
  });

  test("すべてのオプションを指定した設定を読み、apiBaseUrl の末尾スラッシュを吸収する", () => {
    const { root, soul } = setupSoul();
    const cfg = parseSlackBotConfig(
      JSON.stringify({
        name: "ops.bot",
        soulFile: soul,
        agent: "claude",
        level: "high",
        apiBaseUrl: "http://127.0.0.1:8080/slack/api///",
        workdir: join(root, "work"),
        timeoutSec: 900,
        concurrency: 5,
      }),
    );
    expect(cfg).toEqual({
      name: "ops.bot",
      soulFile: soul,
      agent: "claude",
      level: "high",
      apiBaseUrl: "http://127.0.0.1:8080/slack/api",
      workdir: join(root, "work"),
      timeoutSec: 900,
      concurrency: 5,
    });
  });

  test("不正な設定値や未知のキーを拒否する", () => {
    const { root, soul } = setupSoul();
    const valid = { name: "ok-bot", soulFile: soul };

    expect(() => parseSlackBotConfig("{bad")).toThrow(/JSON/);
    expect(() => parseSlackBotConfig("[]")).toThrow(/JSON オブジェクト/);
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, botToken: "x" }))).toThrow(
      /未知の項目/,
    );
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, name: "../bad" }))).toThrow(/name/);
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, soulFile: "SOUL.md" }))).toThrow(
      /絶対パス/,
    );
    expect(() =>
      parseSlackBotConfig(JSON.stringify({ ...valid, soulFile: join(root, "missing.md") })),
    ).toThrow(/見つからない/);
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, agent: "other" }))).toThrow(
      /agent/,
    );
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, level: "ultra" }))).toThrow(
      /level/,
    );
    expect(() =>
      parseSlackBotConfig(JSON.stringify({ ...valid, apiBaseUrl: "ws://localhost/slack" })),
    ).toThrow(/http または https/);
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, timeoutSec: 0 }))).toThrow(
      /timeoutSec/,
    );
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, concurrency: 1.5 }))).toThrow(
      /concurrency/,
    );
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, concurrency: 0 }))).toThrow(
      /concurrency/,
    );
  });
});

describe("loadSlackBotConfig", () => {
  test("ファイルから読み込み、ディレクトリや不在ファイルは拒否する", () => {
    const { root, soul } = setupSoul();
    const cfgPath = join(root, "bot.json");
    writeFileSync(cfgPath, JSON.stringify({ name: "sample-bot", soulFile: soul }));
    expect(loadSlackBotConfig(cfgPath).name).toBe("sample-bot");
    mkdirSync(join(root, "sub"));
    expect(() => loadSlackBotConfig(join(root, "sub"))).toThrow(/見つからない/);
    expect(() => loadSlackBotConfig(join(root, "missing.json"))).toThrow(/見つからない/);
  });
});

describe("resolveSlackRuntimeEnv", () => {
  test("環境変数を優先し、ダミートークン文字列を許容する", () => {
    const resolved = resolveSlackRuntimeEnv(
      { apiBaseUrl: "http://127.0.0.1:8080/slack/api" },
      {
        SLACK_API_BASE_URL: "https://monitoring-pr-42.wpcapp.net/slack/api/",
        SLACK_BOT_TOKEN: "xoxb-spiffe",
        SLACK_APP_TOKEN: "xapp-spiffe",
      },
    );
    expect(resolved).toEqual({
      apiBaseUrl: "https://monitoring-pr-42.wpcapp.net/slack/api",
      botToken: "xoxb-spiffe",
      appToken: "xapp-spiffe",
    });

    const fallbackUrl = resolveSlackRuntimeEnv(
      { apiBaseUrl: "http://127.0.0.1:8080/slack/api/" },
      {
        SLACK_BOT_TOKEN: "custom-bot-token",
        SLACK_APP_TOKEN: "custom-app-token",
      },
    );
    expect(fallbackUrl.apiBaseUrl).toBe("http://127.0.0.1:8080/slack/api");
    expect(fallbackUrl.botToken).toBe("custom-bot-token");
    expect(fallbackUrl.appToken).toBe("custom-app-token");
  });

  test("必須の環境変数が欠けている場合はエラーにする", () => {
    expect(() =>
      resolveSlackRuntimeEnv({ apiBaseUrl: null }, { SLACK_BOT_TOKEN: "a", SLACK_APP_TOKEN: "b" }),
    ).toThrow(/SLACK_API_BASE_URL/);
    expect(() =>
      resolveSlackRuntimeEnv(
        { apiBaseUrl: "http://127.0.0.1:8080/slack/api" },
        { SLACK_APP_TOKEN: "b" },
      ),
    ).toThrow(/SLACK_BOT_TOKEN/);
    expect(() =>
      resolveSlackRuntimeEnv(
        { apiBaseUrl: "http://127.0.0.1:8080/slack/api" },
        { SLACK_BOT_TOKEN: "a" },
      ),
    ).toThrow(/SLACK_APP_TOKEN/);
    expect(normalizeApiBaseUrl("http://127.0.0.1:8080/slack/api/")).toBe(
      "http://127.0.0.1:8080/slack/api",
    );
  });
});
