import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const MAIN = join(import.meta.dir, "main.ts");

const cleanups: WorldCleanup[] = [];
afterEach(() => cleanupWorlds(cleanups));

describe("autopilot-slack-bot E2E", () => {
  test("check-config は妥当な設定で 0、不正な設定で 2 を返す", async () => {
    const w = setupWorld(cleanups);
    const okCfg = join(w.root, "ok.json");
    writeFileSync(
      okCfg,
      JSON.stringify({
        name: "valid-bot",
        soulFile: w.soul,
        botTokenFile: "/run/spiffe/bot.jwt",
        appTokenFile: "/run/spiffe/app.jwt",
      }),
    );
    const badCfg = join(w.root, "bad.json");
    writeFileSync(badCfg, JSON.stringify({ name: "bad-bot", soulFile: join(w.root, "none.md") }));
    const badTokenPathCfg = join(w.root, "bad-token-path.json");
    writeFileSync(
      badTokenPathCfg,
      JSON.stringify({ name: "bad-token-bot", soulFile: w.soul, botTokenFile: "relative/bot.jwt" }),
    );

    const runCli = async (args: string[]) => {
      const p = Bun.spawn([process.execPath, MAIN, ...args], {
        cwd: w.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, stdout, stderr };
    };

    const r1 = await runCli(["check-config", "--file", okCfg]);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain("valid-bot: ok");

    const r2 = await runCli(["check-config", "--file", badCfg]);
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain("soulFile");

    const r3 = await runCli(["check-config", "--file", badTokenPathCfg]);
    expect(r3.code).toBe(2);
    expect(r3.stderr).toContain("botTokenFile");
  });

  test("起動リトライ・重複排除・会話継続 (resume)・履歴引き継ぎ・自己ループ防止が連動して動く", async () => {
    const w = setupWorld(cleanups, {
      "1": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "agy-conv-1", response: "一次調査完了" }),
      },
      "2": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "agy-conv-1", response: "追加確認完了" }),
      },
      "3": {
        code: 1,
        stderr: "conversation not found",
      },
      "4": {
        code: 0,
        stdout: JSON.stringify({
          conversation_id: "agy-conv-2",
          response: "新規セッションで引き継ぎ完了",
        }),
      },
    });

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;
    process.env.ORCA_PANE_KEY = "should-not-leak";

    const mock = createMockSlackServer({
      botUserId: "U_DYN_BOT",
      botId: "B_DYN_BOT",
      authFailCount: 2,
      threads: {
        "C_OPS:100.1": [
          { ts: "100.1", bot_id: "B_AM", username: "alertmanager", text: "[firing] HighErrorRate" },
          { ts: "100.2", user: "U_ALICE", text: "<@U_DYN_BOT> 原因を調べて", thread_ts: "100.1" },
        ],
      },
    });
    w.servers.push(mock.srv);

    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({
        name: "ops-investigator",
        soulFile: w.soul,
        apiBaseUrl: "http://127.0.0.1:9999/unused",
      }),
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
      type: "message",
      channel: "C_OPS",
      user: "U_DYN_BOT",
      ts: "99.1",
      text: "self",
    });
    mock.emitEvent({
      type: "app_mention",
      channel: "C_OPS",
      user: "U_OTHER_BOT",
      bot_id: "B_OTHER",
      ts: "99.2",
      text: "<@U_DYN_BOT> loop",
    });

    const turn1Event = {
      channel: "C_OPS",
      user: "U_ALICE",
      ts: "100.2",
      thread_ts: "100.1",
      text: "<@U_DYN_BOT> 原因を調べて",
    };
    mock.emitEvent({ ...turn1Event, type: "message" });
    mock.emitEvent({ ...turn1Event, type: "app_mention" });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]).toEqual({
      channel: "C_OPS",
      thread_ts: "100.1",
      text: "一次調査完了",
    });
    expect(mock.repliesCalls).toEqual([{ channel: "C_OPS", ts: "100.1" }]);

    mock.emitEvent({
      type: "message",
      channel: "C_OPS",
      user: "U_ALICE",
      ts: "100.3",
      thread_ts: "100.1",
      text: "関連 PR も見て",
    });

    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]!.text).toBe("追加確認完了");

    mock.emitEvent({
      type: "message",
      channel: "C_OPS",
      user: "U_ALICE",
      ts: "100.4",
      thread_ts: "100.1",
      text: "最後に要約して",
    });

    await waitFor(() => mock.posted.length === 3);
    expect(mock.posted[2]!.text).toBe("新規セッションで引き継ぎ完了");
    expect(mock.repliesCalls).toHaveLength(2);

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);

    const calls = w.readCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0]!.envOrca).toEqual([]);
    expect(calls[0]!.envSlackTokens).toEqual([]);
    expect(calls[0]!.prompt).toContain("[firing] HighErrorRate");
    expect(calls[1]!.args).toContain("--conversation");
    expect(calls[1]!.args).toContain("agy-conv-1");
    expect(calls[2]!.args).toContain("--conversation");
    expect(calls[2]!.args).toContain("agy-conv-1");
    expect(calls[3]!.args).not.toContain("--conversation");
    expect(calls[3]!.prompt).toContain("[firing] HighErrorRate");
  });

  test("unavailable 時は次候補へフォールバックし、作業ディレクトリ変更後なら切り替えずスレッドへエラー通知する", async () => {
    const w = setupWorld(cleanups, {
      "1": { code: 1, stderr: "You've hit your session limit" },
      "2": { code: 0, stdout: "claude が調査完了" },
    });

    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const workdir = join(w.root, "work");
    mkdirSync(workdir);

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "fallback-bot", soulFile: w.soul, workdir }),
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
      ts: "200.1",
      text: "<@U_CUSTOM_BOT> check",
    });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]!.text).toBe("claude が調査完了");

    w.setScript({
      "3": {
        code: 1,
        stderr: "You've hit your session limit",
        writeWorkdirFile: join(workdir, "touched.txt"),
      },
      "4": { code: 0, stdout: "should not run" },
    });

    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "300.1",
      text: "<@U_CUSTOM_BOT> check2",
    });

    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]!.text).toContain("[エラー]");
    expect(mock.posted[1]!.text).toContain("切り替えない");

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
    expect(w.readCalls().map((c) => c.agent)).toEqual(["agy", "claude", "agy"]);
  });

  test("resume が作業ディレクトリ変更後や通常エラーで失敗したら新規セッションへ切り替えずエラー通知する", async () => {
    const w = setupWorld(cleanups, {
      "1": {
        code: 0,
        stdout: JSON.stringify({ conversation_id: "agy-s1", response: "初回完了" }),
      },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const workdir = join(w.root, "work");
    mkdirSync(workdir);

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(
      JSON.stringify({ name: "resume-guard-bot", soulFile: w.soul, workdir }),
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

    // 1. resume が作業ディレクトリを変更した後に unavailable で失敗 -> 切り替えない
    w.setScript({
      "2": {
        code: 1,
        stderr: "conversation not found",
        writeWorkdirFile: join(workdir, "partial.txt"),
      },
      "3": { code: 0, stdout: "should not run" },
    });
    mock.emitEvent({
      type: "message",
      channel: "C1",
      user: "U1",
      ts: "100.2",
      thread_ts: "100.1",
      text: "follow up 1",
    });
    await waitFor(() => mock.posted.length === 2);
    expect(mock.posted[1]!.text).toContain("[エラー]");
    expect(mock.posted[1]!.text).toContain("切り替えない");

    // 2. resume が通常の error (exit 1) で失敗 -> unavailable ではないため切り替えない
    w.setScript({
      "3": { code: 1, stderr: "unexpected crash" },
      "4": { code: 0, stdout: "should not run" },
    });
    mock.emitEvent({
      type: "message",
      channel: "C1",
      user: "U1",
      ts: "100.3",
      thread_ts: "100.1",
      text: "follow up 2",
    });
    await waitFor(() => mock.posted.length === 3);
    expect(mock.posted[2]!.text).toContain("[エラー]");
    expect(mock.posted[2]!.text).toContain("切り替えない");

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
    expect(w.readCalls()).toHaveLength(3);
  });

  test("timeoutSec を超えたらエージェントを停止してスレッドへタイムアウト通知を投稿する", async () => {
    const w = setupWorld(cleanups, {
      "1": { code: 0, sleepMs: 5000, stdout: "never" },
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
      JSON.stringify({ name: "timeout-bot", soulFile: w.soul, timeoutSec: 0.2 }),
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
      ts: "500.1",
      text: "<@U_CUSTOM_BOT> slow",
    });

    await waitFor(() => mock.posted.length === 1);
    expect(mock.posted[0]!.thread_ts).toBe("500.1");
    expect(mock.posted[0]!.text).toContain("[エラー]");
    expect(mock.posted[0]!.text).toContain("タイムアウト");

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });

  test("エージェント実行中に SIGTERM を受けたら子プロセスを停止して exit 0 で終わる", async () => {
    const w = setupWorld(cleanups);
    const pidFile = join(w.root, "agent.pid");
    w.setScript({
      "1": { code: 0, sleepMs: 10_000, pidFile },
    });
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [claude]\n");
    process.env.AUTOPILOT_MODELS = modelsFile;

    const mock = createMockSlackServer({});
    w.servers.push(mock.srv);
    process.env.SLACK_API_BASE_URL = mock.baseUrl;
    process.env.SLACK_BOT_TOKEN = "xoxb-spiffe";
    process.env.SLACK_APP_TOKEN = "xapp-spiffe";

    const cfg = parseSlackBotConfig(JSON.stringify({ name: "sigterm-bot", soulFile: w.soul }));
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
      ts: "600.1",
      text: "<@U_CUSTOM_BOT> run",
    });

    let agentPid = 0;
    await waitFor(() => {
      try {
        agentPid = Number(readFileSync(pidFile, "utf8"));
        return agentPid > 0;
      } catch {
        return false;
      }
    });

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
    // SIGTERM での中断時はスレッドへ不要なエラー返信を出さない
    expect(mock.posted).toHaveLength(0);

    let alive = true;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(agentPid, 0);
        await Bun.sleep(25);
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);
  });

  test("同一スレッドの連続投稿は直列実行し、異なるスレッドは並列実行する", async () => {
    const w = setupWorld(cleanups, {
      byPrompt: {
        '"ts": "10.1"': { code: 0, sleepMs: 180, stdout: "reply-A1" },
        '"ts": "10.2"': { code: 0, sleepMs: 10, stdout: "reply-A2" },
        '"ts": "20.1"': { code: 0, sleepMs: 20, stdout: "reply-B1" },
      },
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
      JSON.stringify({ name: "concurrency-bot", soulFile: w.soul, concurrency: 2 }),
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

    mock.emitEvent({ type: "app_mention", channel: "C1", user: "U1", ts: "10.1", text: "A1" });
    mock.emitEvent({
      type: "app_mention",
      channel: "C1",
      user: "U1",
      ts: "10.2",
      thread_ts: "10.1",
      text: "A2",
    });
    mock.emitEvent({ type: "app_mention", channel: "C1", user: "U1", ts: "20.1", text: "B1" });

    await waitFor(() => mock.posted.length === 3);

    expect(mock.posted.map((m) => `${m.thread_ts}:${m.text}`)).toEqual([
      "20.1:reply-B1",
      "10.1:reply-A1",
      "10.1:reply-A2",
    ]);

    process.emit("SIGTERM", "SIGTERM");
    expect(await botPromise).toBe(0);
  });
});
