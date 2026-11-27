import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  test("fallback-start 後の保存失敗時もメモリ上の新しい会話を優先して再開する", async () => {
    const w = setupWorld(cleanups, {
      "1": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "agy-A", response: "A の調査完了" }),
      },
      "2": { code: 1, stderr: "conversation not found" },
      "3": { code: 0, stdout: "B の引き継ぎ完了" },
      "4": { code: 0, stdout: "B を継続して完了" },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "fallback-save-bot", soulFile: w.soul }),
    );
    const threadsDir = join(w.stateDir, "slack-bot", "fallback-save-bot", "threads");

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

    try {
      await waitFor(() => mock.wsClients.size === 1);
      // Turn 1: agy-A がディスクへ保存される
      mock.emitEvent({
        type: "app_mention",
        channel: "C1",
        user: "U1",
        ts: "100.1",
        text: "<@U_CUSTOM_BOT> 初回",
      });
      await waitFor(() => mock.posted.length === 1);

      // ディスクに agy-A を残したまま書き込み不可にする
      chmodSync(threadsDir, 0o500);

      // Turn 2: agy-A の resume が unavailable -> claude へ fallback-start し保存失敗
      w.setScript({
        "2": { code: 1, stderr: "conversation not found" },
        "3": { code: 1, stderr: "You've hit your session limit" },
        "4": { code: 0, stdout: "B で引継完了" },
      });
      mock.emitEvent({
        type: "message",
        channel: "C1",
        user: "U1",
        ts: "100.2",
        thread_ts: "100.1",
        text: "引き継いで",
      });
      await waitFor(() => mock.posted.length === 2);
      expect(mock.posted[1]!.text).toBe("B で引継完了");

      w.setScript({
        "5": { code: 0, stdout: "B で継続完了" },
      });
      mock.emitEvent({
        type: "message",
        channel: "C1",
        user: "U1",
        ts: "100.3",
        thread_ts: "100.1",
        text: "続き",
      });
      await waitFor(() => mock.posted.length === 3);
      expect(mock.posted[2]!.text).toBe("B で継続完了");

      const calls = w.readCalls();
      expect(calls).toHaveLength(5);
      // Turn 3 (5回目) はディスクの古い agy-A ではなくメモリ上の claude セッションを再開する
      expect(calls[4]!.agent).toBe("claude");
      expect(calls[4]!.args).toContain("--resume");
      const claudeStartSessionId = calls[3]!.args[calls[3]!.args.indexOf("--session-id") + 1] ?? "";
      expect(claudeStartSessionId.length).toBeGreaterThan(0);
      expect(calls[4]!.args).toContain(claudeStartSessionId);
    } finally {
      chmodSync(threadsDir, 0o755);
      process.emit("SIGTERM", "SIGTERM");
      expect(await botPromise).toBe(0);
    }
  });

  test("未追跡ファイルの上書きや git 比較失敗時は別担当へ切り替えず、git 子プロセスにも認証情報を渡さない", async () => {
    const w = setupWorld(cleanups);
    const realGit = Bun.which("git")!;
    const gitEnvLog = join(w.root, "git-env.jsonl");
    const gitWrapper = join(w.bin, "git");
    writeFileSync(
      gitWrapper,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const leaked = Object.keys(process.env).filter((k) => /^SLACK_.*_TOKEN(?:_FILE)?$|^ORCA_/.test(k));
appendFileSync(${JSON.stringify(gitEnvLog)}, JSON.stringify({ args: process.argv.slice(2), leaked }) + "\\n");
if (process.env.FAIL_GIT_STATUS === "1" && process.argv.includes("status")) {
  process.stderr.write("git status failed\\n");
  process.exit(128);
}
const res = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(res.status ?? 1);
`,
    );
    chmodSync(gitWrapper, 0o755);

    const workdir = join(w.root, "repo");
    mkdirSync(workdir);
    const runGit = (args: string[]) =>
      Bun.spawnSync([realGit, "-C", workdir, ...args], { stdout: "pipe", stderr: "pipe" });
    runGit(["init"]);
    runGit(["config", "user.email", "test@example.com"]);
    runGit(["config", "user.name", "Test"]);
    writeFileSync(join(workdir, "README.md"), "init\n");
    runGit(["add", "README.md"]);
    runGit(["commit", "-m", "init"]);

    // 既存の未追跡ファイルを用意する
    const untracked = join(workdir, "scratch.txt");
    writeFileSync(untracked, "alpha");

    w.setScript({
      "1": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "agy-s1", response: "初回完了" }),
      },
      "2": {
        code: 1,
        stderr: "conversation not found",
        // 同名・同バイト長で未追跡ファイルを上書きする
        writeWorkdirFile: untracked,
        writeWorkdirContent: "bravo",
      },
      "3": { code: 0, stdout: "should not run" },
    });

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-secret-git-check";
    process.env.SLACK_APP_TOKEN = "xapp-secret-git-check";
    process.env.SLACK_BOT_TOKEN_FILE = "";
    process.env.ORCA_PANE_KEY = "orca-secret";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "git-guard-bot", soulFile: w.soul, workdir }),
    );
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
      text: "<@U_CUSTOM_BOT> start",
    });
    await waitFor(() => mock.posted.length === 1);

    // 未追跡ファイル内容を同サイズで上書き後に unavailable -> 切り替えない
    mock.emitEvent({
      type: "message",
      channel: "C1",
      user: "U1",
      ts: "100.2",
      thread_ts: "100.1",
      text: "follow up",
    });
    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]!.text).toContain("[エラー]");
    expect(mock.posted[1]!.text).toContain("切り替えない");
    expect(w.readCalls()).toHaveLength(2);

    // git status が失敗した場合も切り替えない
    process.env.FAIL_GIT_STATUS = "1";
    w.setScript({
      "3": { code: 1, stderr: "You've hit your session limit" },
      "4": { code: 0, stdout: "should not run" },
    });
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "200.1",
      text: "<@U_CUSTOM_BOT> check fail",
    });
    await waitFor(() => mock.posted.length === 3);
    expect(mock.posted[2]!.text).toContain("[エラー]");
    expect(mock.posted[2]!.text).toContain("切り替えない");
    expect(w.readCalls()).toHaveLength(3);
    delete process.env.FAIL_GIT_STATUS;

    const gitRecords = readFileSync(gitEnvLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { args: string[]; leaked: string[] });
    expect(gitRecords.length).toBeGreaterThan(0);
    for (const rec of gitRecords) {
      expect(rec.leaked).toEqual([]);
    }

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });

  test("conversations.replies がトークンファイル読込エラーで失敗しても JWT パスをプロンプトへ出さずログに残す", async () => {
    const w = setupWorld(cleanups, {
      claude: { code: 0, stdout: "履歴なしで確認完了" },
    });
    const botFile = join(w.root, "secret-bot.jwt");
    const appFile = join(w.root, "secret-app.jwt");
    writeFileSync(botFile, "jwt-bot-init\n");
    writeFileSync(appFile, "jwt-app-init\n");

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN_FILE = botFile;
    process.env.SLACK_APP_TOKEN_FILE = appFile;

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "token-err-prompt-bot", soulFile: w.soul }),
    );
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
    // 接続後に一時的にトークンファイルを空にする
    writeFileSync(botFile, "");
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.1",
      text: "<@U_CUSTOM_BOT> 調べて",
    });

    await waitFor(() => w.readCalls().length === 1);
    // その後トークンファイルが復旧したとする（返信投稿用）
    writeFileSync(botFile, "jwt-bot-recovered\n");
    await waitFor(() => mock.posted.length === 1);

    const prompt = w.readCalls()[0]!.prompt;
    expect(prompt).toContain("認証情報を読み込めず履歴取得に失敗した");
    expect(prompt).not.toContain(botFile);

    const logText = readFileSync(
      join(w.stateDir, "logs", "slack-bot-token-err-prompt-bot.log"),
      "utf8",
    );
    expect(logText).toContain(botFile);

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });

  test("conversations.replies 待機中に SIGTERM を受けたら新しいエージェントを起動しない", async () => {
    const w = setupWorld(cleanups, {
      claude: { code: 0, stdout: "should not run" },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({
      repliesDelayMs: 200,
      onRepliesCalled: () => {
        process.emit("SIGTERM", "SIGTERM");
      },
    });
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "sigterm-pre-run-bot", soulFile: w.soul }),
    );
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
      text: "<@U_CUSTOM_BOT> 調査",
    });

    expect(await botPromise).toBe(0);
    expect(w.readCalls()).toHaveLength(0);
  });

  test("長文返信の 1 通目が成功して 2 通目で失敗しても参加済みとして保存し続報を受け付ける", async () => {
    const longReply = `${"あ".repeat(3700)}\n${"い".repeat(500)}`;
    const w = setupWorld(cleanups, {
      "1": { code: 0, stdout: longReply },
      "2": { code: 0, stdout: "続報完了" },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({
      failPostOnCall: 2,
    });
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "partial-post-bot", soulFile: w.soul }));
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

    try {
      await waitFor(() => mock.wsClients.size === 1);
      mock.emitEvent({
        type: "app_mention",
        channel: "C1",
        user: "U1",
        ts: "100.1",
        text: "<@U_CUSTOM_BOT> 長文で",
      });

      await waitFor(() => mock.posted.length === 1);
      await Bun.sleep(80);

      // メンションなしの続報でも参加済みスレッドとして処理される
      mock.emitEvent({
        type: "message",
        channel: "C1",
        user: "U1",
        ts: "100.2",
        thread_ts: "100.1",
        text: "続きも教えて",
      });

      await waitFor(() => mock.posted.length === 2);
      expect(mock.posted[1]!.text).toBe("続報完了");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      expect(await botPromise).toBe(0);
    }
  });

  test("再起動をまたいで同じ ts が再配信されても二重実行せず、新しい ts のみ処理する", async () => {
    const w = setupWorld(cleanups, {
      "1": { code: 0, stdout: "初回応答" },
      "2": { code: 0, stdout: "2回目応答" },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "restart-dedup-bot", soulFile: w.soul }),
    );
    const runOpts = {
      config: cfg,
      pingIntervalMs: 0,
      inactivityTimeoutMs: 10_000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
      authRetryInitialMs: 10,
      authRetryMaxMs: 20,
    };

    const bot1 = runSlackBot(runOpts);
    await waitFor(() => mock.wsClients.size === 1);
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "100.1",
      text: "<@U_CUSTOM_BOT> 初回",
    });
    await waitFor(() => mock.posted.length === 1);
    process.emit("SIGTERM", "SIGTERM");
    expect(await bot1).toBe(0);
    await waitFor(() => mock.wsClients.size === 0);

    // 2 回目起動（同じ stateDir）で同じ 100.1 が再配信されても無視し、100.2 だけ実行する
    const bot2 = runSlackBot(runOpts);
    try {
      await waitFor(() => mock.wsClients.size === 1);
      mock.emitEvent({
        type: "app_mention",
        channel: "C1",
        user: "U1",
        ts: "100.1",
        text: "<@U_CUSTOM_BOT> 初回",
      });
      mock.emitEvent({
        type: "message",
        channel: "C1",
        user: "U1",
        ts: "100.2",
        thread_ts: "100.1",
        text: "追加確認",
      });
      await waitFor(() => mock.posted.length === 2);
      expect(mock.posted[1]!.text).toBe("2回目応答");

      const calls = w.readCalls();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args).toContain("--resume");
    } finally {
      process.emit("SIGTERM", "SIGTERM");
      expect(await bot2).toBe(0);
    }
  });
});
