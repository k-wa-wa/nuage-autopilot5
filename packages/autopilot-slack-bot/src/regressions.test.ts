import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSlackBotConfig } from "./config.ts";
import { runSlackBot } from "./runner.ts";
import {
  cleanupWorlds,
  createMockSlackServer,
  setupWorld,
  type WorldCleanup,
  waitFor,
} from "./testing/helpers.ts";

const cleanups: WorldCleanup[] = [];
afterEach(() => cleanupWorlds(cleanups));

describe("autopilot-slack-bot regressions", () => {
  test("handleDecision 内で例外（壊れた models.yaml）が起きても常駐を続け、エラー通知し修復後に処理できる", async () => {
    const w = setupWorld(cleanups, {
      claude: { code: 0, stdout: "復旧後の調査完了" },
    });
    const modelsFile = join(w.root, "models.yaml");
    // parseModelTable が throw する不正な YAML
    writeFileSync(modelsFile, "unknown_agent:\n  high: [m]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-secret-leak-check";
    process.env.SLACK_APP_TOKEN = "xapp-secret-leak-check";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "resilient-bot", soulFile: w.soul }));
    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);

    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.1",
      text: "<@U_CUSTOM_BOT> 調べて",
    });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]!.thread_ts).toBe("100.1");
    expect(mock.posted[0]!.text).toContain("[エラー]");
    expect(mock.posted[0]!.text).toContain("知らないエージェント");

    // 常駐が継続しており、models.yaml を直すと次のメンションが成功する
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "200.1",
      text: "<@U_CUSTOM_BOT> 再調査",
    });

    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]).toEqual({
      channel: "C1",
      thread_ts: "200.1",
      text: "復旧後の調査完了",
    });

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });

  test("日本語 50,000 文字超の長いスレッド履歴でも E2BIG にならず最新履歴を優先して実行できる", async () => {
    const w = setupWorld(cleanups, {
      claude: { code: 0, stdout: "長文スレッド調査完了" },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({
      threads: {
        "C1:100.1": [
          { ts: "100.1", user: "U1", text: "あ".repeat(25_000) },
          { ts: "100.2", user: "U1", text: "い".repeat(25_000) },
          { ts: "100.3", user: "U1", text: "<@U_CUSTOM_BOT> 最新の質問" },
        ],
      },
    });
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-secret-token";
    process.env.SLACK_APP_TOKEN = "xapp-secret-token";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "long-thread-bot", soulFile: w.soul }));
    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.3",
      thread_ts: "100.1",
      text: "<@U_CUSTOM_BOT> 最新の質問",
    });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]!.text).toBe("長文スレッド調査完了");

    const calls = w.readCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("最新の質問");
    expect(Buffer.byteLength(calls[0]!.prompt, "utf8")).toBeLessThan(128 * 1024);
    // SLACK_*_TOKEN が子プロセスの環境変数に渡っていないことも合わせて確認
    expect(calls[0]!.envSlackTokens).toEqual([]);

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });

  test("apps.connections.open が非リトライエラー (401) で失敗しても実行中スレッドの完了を待って返信してから終了する", async () => {
    const w = setupWorld(cleanups, {
      byPrompt: {
        '"ts": "100.1"': { code: 0, sleepMs: 150, stdout: "進行中の調査結果" },
      },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({
      failConnectionsOpenOnCall: 2,
    });
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "drain-on-err-bot", soulFile: w.soul }));
    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.1",
      text: "<@U_CUSTOM_BOT> 調査中",
    });
    await waitFor(() => w.readCalls().length === 1);

    // 調査実行中に disconnect を送ると 2 回目の apps.connections.open が 401 で失敗する
    const ws = [...mock.wsClients][0]!;
    ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));

    // 戻り値は 1 だが、queue.drain() により進行中の調査結果が投稿されてから終わる
    expect(await botPromise).toBe(1);
    expect(mock.posted).toEqual([{ channel: "C1", thread_ts: "100.1", text: "進行中の調査結果" }]);
  });

  test("conversations.replies 失敗時は空履歴と誤認させずプロンプトに取得失敗を明記する", async () => {
    const w = setupWorld(cleanups, {
      claude: { code: 0, stdout: "履歴なし前提で確認した" },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({
      failRepliesError: "channel_not_found",
    });
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "replies-err-bot", soulFile: w.soul }));
    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.2",
      thread_ts: "100.1",
      text: "<@U_CUSTOM_BOT> 調査して",
    });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]!.text).toBe("履歴なし前提で確認した");

    const calls = w.readCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("スレッド履歴の取得に失敗した");
    expect(calls[0]!.prompt).toContain("channel_not_found");
    expect(calls[0]!.prompt).not.toContain("(スレッド履歴なし)");

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });

  test("chat.postMessage 成功後に sessionStore.save が失敗しても [エラー] を二重投稿せず継続返信を受け付ける", async () => {
    const w = setupWorld(cleanups, {
      "1": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "conv-save-err", response: "一次調査の結果" }),
      },
      "2": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "conv-save-err", response: "追加確認の結果" }),
      },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    // $AUTOPILOT_STATE_DIR/slack-bot を通常ファイルにして save 時の mkdirSync を確実に失敗させる
    writeFileSync(join(w.stateDir, "slack-bot"), "not-a-directory");

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "save-err-bot", soulFile: w.soul }));
    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.1",
      text: "<@U_CUSTOM_BOT> 調べて",
    });

    await waitFor(() => mock.posted.length === 1);
    // 少し待っても二重の [エラー] 投稿が起きないことを確かめる
    await Bun.sleep(100);
    expect(mock.posted).toEqual([{ channel: "C1", thread_ts: "100.1", text: "一次調査の結果" }]);

    // save 失敗後もメモリ上の参加状態・セッションを保持しており、人間の後続返信で resume できる
    mock.emitEvent({
      type: "message",
      channel: "C1",
      user: "U1",
      ts: "100.2",
      thread_ts: "100.1",
      text: "続けて確認して",
    });

    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]).toEqual({
      channel: "C1",
      thread_ts: "100.1",
      text: "追加確認の結果",
    });
    const calls = w.readCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain("--conversation");
    expect(calls[1]!.args).toContain("conv-save-err");

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });

  test("SLACK_BOT_TOKEN_FILE / SLACK_APP_TOKEN_FILE のローテーションに追従し、子プロセスへは *_FILE も渡さない", async () => {
    const w = setupWorld(cleanups, {
      claude: { code: 0, stdout: "トークンファイル経由で完了" },
    });
    const botFile = join(w.root, "bot.jwt");
    const appFile = join(w.root, "app.jwt");
    writeFileSync(botFile, "jwt-bot-1\n");
    writeFileSync(appFile, "jwt-app-1\n");

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN_FILE = botFile;
    process.env.SLACK_APP_TOKEN_FILE = appFile;
    process.env.SLACK_BOT_TOKEN = "unused-static-bot";
    process.env.SLACK_APP_TOKEN = "unused-static-app";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "token-file-bot", soulFile: w.soul }));
    const botPromise = runSlackBot({
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    });

    await waitFor(() => mock.wsClients.size === 1);

    // 接続後に spiffe-helper がファイルをローテーションしたとする
    writeFileSync(botFile, "jwt-bot-2\n");
    writeFileSync(appFile, "jwt-app-2\n");

    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.1",
      text: "<@U_CUSTOM_BOT> 確認",
    });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]!.text).toBe("トークンファイル経由で完了");

    // 起動時の auth.test / apps.connections.open は v1、ローテーション後の replies / postMessage は v2 を使う
    expect(mock.apiAuthHeaders.find((h) => h.method === "auth.test")?.authorization).toBe(
      "Bearer jwt-bot-1",
    );
    expect(
      mock.apiAuthHeaders.find((h) => h.method === "apps.connections.open")?.authorization,
    ).toBe("Bearer jwt-app-1");
    expect(
      mock.apiAuthHeaders.find((h) => h.method === "conversations.replies")?.authorization,
    ).toBe("Bearer jwt-bot-2");
    expect(mock.apiAuthHeaders.find((h) => h.method === "chat.postMessage")?.authorization).toBe(
      "Bearer jwt-bot-2",
    );

    // disconnect 後の再接続では新しい appTokenFile (v2) を使う
    const ws = [...mock.wsClients][0]!;
    ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    await waitFor(
      () => mock.apiAuthHeaders.filter((h) => h.method === "apps.connections.open").length >= 2,
    );
    const openHeaders = mock.apiAuthHeaders.filter((h) => h.method === "apps.connections.open");
    expect(openHeaders[1]?.authorization).toBe("Bearer jwt-app-2");

    // 子プロセスには SLACK_*_TOKEN も SLACK_*_TOKEN_FILE も渡っていない
    const calls = w.readCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.envSlackTokens).toEqual([]);

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });
});
