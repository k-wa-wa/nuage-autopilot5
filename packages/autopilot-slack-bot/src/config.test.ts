import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileTokenProvider,
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
      botTokenFile: null,
      appTokenFile: null,
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
        botTokenFile: "/run/spiffe/bot-token.jwt",
        appTokenFile: "/run/spiffe/app-token.jwt",
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
      botTokenFile: "/run/spiffe/bot-token.jwt",
      appTokenFile: "/run/spiffe/app-token.jwt",
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
    expect(() =>
      parseSlackBotConfig(JSON.stringify({ ...valid, botTokenFile: "relative/bot.jwt" })),
    ).toThrow(/botTokenFile.*絶対パス/);
    expect(() =>
      parseSlackBotConfig(JSON.stringify({ ...valid, appTokenFile: "relative/app.jwt" })),
    ).toThrow(/appTokenFile.*絶対パス/);
    expect(() => parseSlackBotConfig(JSON.stringify({ ...valid, botTokenFile: "   " }))).toThrow(
      /botTokenFile/,
    );
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
  test("環境変数を優先し、ダミートークンや JWT 文字列を許容する", async () => {
    const resolved = resolveSlackRuntimeEnv(
      {
        apiBaseUrl: "http://127.0.0.1:8080/slack/api",
        botTokenFile: null,
        appTokenFile: null,
      },
      {
        SLACK_API_BASE_URL: "https://monitoring.wpcapp.net/slack/api/",
        SLACK_BOT_TOKEN: "eyJhbGciOiJSUzI1NiJ9.bot.sig",
        SLACK_APP_TOKEN: "custom-app-token",
      },
    );
    expect(resolved.apiBaseUrl).toBe("https://monitoring.wpcapp.net/slack/api");
    expect(resolved.botTokenSource).toEqual({
      kind: "env",
      value: "eyJhbGciOiJSUzI1NiJ9.bot.sig",
    });
    expect(resolved.appTokenSource).toEqual({ kind: "env", value: "custom-app-token" });
    expect(await resolved.botToken()).toBe("eyJhbGciOiJSUzI1NiJ9.bot.sig");
    expect(await resolved.appToken()).toBe("custom-app-token");

    const fallbackUrl = resolveSlackRuntimeEnv(
      {
        apiBaseUrl: "http://127.0.0.1:8080/slack/api/",
        botTokenFile: null,
        appTokenFile: null,
      },
      {
        SLACK_BOT_TOKEN: "custom-bot-token",
        SLACK_APP_TOKEN: "custom-app-token",
      },
    );
    expect(fallbackUrl.apiBaseUrl).toBe("http://127.0.0.1:8080/slack/api");
    expect(await fallbackUrl.botToken()).toBe("custom-bot-token");
    expect(await fallbackUrl.appToken()).toBe("custom-app-token");
  });

  test("*_FILE 環境変数は設定 JSON の *TokenFile や静的トークンより優先され、都度ファイルを読み込む", async () => {
    const { root } = setupSoul();
    const cfgBotFile = join(root, "cfg-bot.jwt");
    const envBotFile = join(root, "env-bot.jwt");
    const cfgAppFile = join(root, "cfg-app.jwt");
    writeFileSync(cfgBotFile, "cfg-bot-v1\n");
    writeFileSync(envBotFile, "  eyJhbGciOiJSUzI1NiJ9.env-v1 \n");
    writeFileSync(cfgAppFile, "\ncfg-app-v1\n");

    const resolved = resolveSlackRuntimeEnv(
      {
        apiBaseUrl: "https://monitoring.wpcapp.net/slack/api",
        botTokenFile: cfgBotFile,
        appTokenFile: cfgAppFile,
      },
      {
        SLACK_BOT_TOKEN_FILE: envBotFile,
        SLACK_BOT_TOKEN: "ignored-static-bot",
        SLACK_APP_TOKEN: "ignored-static-app",
      },
    );

    expect(resolved.botTokenSource).toEqual({ kind: "file", path: envBotFile });
    expect(resolved.appTokenSource).toEqual({ kind: "file", path: cfgAppFile });
    expect(await resolved.botToken()).toBe("eyJhbGciOiJSUzI1NiJ9.env-v1");
    expect(await resolved.appToken()).toBe("cfg-app-v1");

    // spiffe-helper によるファイルローテーションに追従する
    writeFileSync(envBotFile, "eyJhbGciOiJSUzI1NiJ9.env-v2\n");
    writeFileSync(cfgAppFile, "cfg-app-v2\n");
    expect(await resolved.botToken()).toBe("eyJhbGciOiJSUzI1NiJ9.env-v2");
    expect(await resolved.appToken()).toBe("cfg-app-v2");
  });

  test("必須の環境変数・設定が欠けている場合はエラーにする", () => {
    expect(() =>
      resolveSlackRuntimeEnv(
        { apiBaseUrl: null, botTokenFile: null, appTokenFile: null },
        { SLACK_BOT_TOKEN: "a", SLACK_APP_TOKEN: "b" },
      ),
    ).toThrow(/SLACK_API_BASE_URL/);
    expect(() =>
      resolveSlackRuntimeEnv(
        { apiBaseUrl: "http://127.0.0.1:8080/slack/api", botTokenFile: null, appTokenFile: null },
        { SLACK_APP_TOKEN: "b" },
      ),
    ).toThrow(/SLACK_BOT_TOKEN/);
    expect(() =>
      resolveSlackRuntimeEnv(
        { apiBaseUrl: "http://127.0.0.1:8080/slack/api", botTokenFile: null, appTokenFile: null },
        { SLACK_BOT_TOKEN: "a" },
      ),
    ).toThrow(/SLACK_APP_TOKEN/);
    expect(normalizeApiBaseUrl("http://127.0.0.1:8080/slack/api/")).toBe(
      "http://127.0.0.1:8080/slack/api",
    );
  });
});

describe("createFileTokenProvider", () => {
  test("一時的な空ファイル書き換えは短時間リトライで回復し、恒久的な空・不在・ディレクトリはエラーにする", async () => {
    const { root } = setupSoul();
    const tokenPath = join(root, "spiffe.jwt");
    writeFileSync(tokenPath, "");

    const provider = createFileTokenProvider({
      label: "SLACK_BOT_TOKEN_FILE",
      filePath: tokenPath,
      maxRetries: 5,
      retryDelayMs: 25,
    });

    // 40ms 後に spiffe-helper が新しい JWT を書き込む
    setTimeout(() => {
      writeFileSync(tokenPath, "  rotated-jwt-value\n");
    }, 40);
    expect(await provider()).toBe("rotated-jwt-value");

    // 恒久的に空なら明確なエラー
    writeFileSync(tokenPath, "   \n");
    await expect(provider()).rejects.toThrow(/SLACK_BOT_TOKEN_FILE.*空/);

    // 存在しないファイルなら明確なエラー
    const missing = createFileTokenProvider({
      label: "SLACK_APP_TOKEN_FILE",
      filePath: join(root, "missing.jwt"),
      maxRetries: 2,
      retryDelayMs: 10,
    });
    await expect(missing()).rejects.toThrow(/SLACK_APP_TOKEN_FILE/);

    // ディレクトリは即座にエラー
    const dirProvider = createFileTokenProvider({
      label: "SLACK_BOT_TOKEN_FILE",
      filePath: root,
      maxRetries: 5,
      retryDelayMs: 50,
    });
    await expect(dirProvider()).rejects.toThrow(/SLACK_BOT_TOKEN_FILE/);
  });
});
