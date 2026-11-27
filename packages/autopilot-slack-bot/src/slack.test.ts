import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { createFileTokenProvider } from "./config.ts";
import { SlackApiError, SlackWebClient, SocketModeClient } from "./slack.ts";

let servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
let tempDirs: string[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs = [];
});

describe("SlackWebClient", () => {
  test("auth.test 未準備 (503) をリトライして user_id / bot_id を取得する", async () => {
    let attempts = 0;
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/slack/api/auth.test") {
          attempts++;
          if (attempts < 3) {
            return new Response(JSON.stringify({ ok: false, error: "unavailable" }), {
              status: 503,
            });
          }
          return Response.json({
            ok: true,
            user_id: "U_DYN_99",
            bot_id: "B_DYN_99",
            user: "dyn-bot",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(srv);

    const client = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api/`,
      botToken: "xoxb-spiffe",
      appToken: "xapp-spiffe",
    });

    const id = await client.waitForAuthTest({ initialDelayMs: 10, maxDelayMs: 20 });
    expect(attempts).toBe(3);
    expect(id).toEqual({ userId: "U_DYN_99", botId: "B_DYN_99", userName: "dyn-bot" });
  });

  test("invalid_auth はリトライせず即失敗する", async () => {
    let attempts = 0;
    const srv = Bun.serve({
      port: 0,
      fetch() {
        attempts++;
        return Response.json({ ok: false, error: "invalid_auth" });
      },
    });
    servers.push(srv);

    const client = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api`,
      botToken: "bad",
      appToken: "bad",
    });

    await expect(client.waitForAuthTest({ initialDelayMs: 10 })).rejects.toBeInstanceOf(
      SlackApiError,
    );
    expect(attempts).toBe(1);
  });

  test("TokenProvider 経由で API 呼び出しのたびに最新トークンを読み、読込エラー時は非リトライ失敗する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-slack-tok-"));
    tempDirs.push(dir);
    const botFile = join(dir, "bot.jwt");
    const appFile = join(dir, "app.jwt");
    writeFileSync(botFile, "bot-jwt-v1\n");
    writeFileSync(appFile, "app-jwt-v1\n");

    const seenAuth: Array<{ path: string; auth: string | null }> = [];
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seenAuth.push({ path: url.pathname, auth: req.headers.get("authorization") });
        if (url.pathname === "/slack/api/auth.test") {
          return Response.json({ ok: true, user_id: "U_1", bot_id: "B_1", user: "bot" });
        }
        if (url.pathname === "/slack/api/chat.postMessage") {
          return Response.json({ ok: true, channel: "C1", ts: "10.2" });
        }
        if (url.pathname === "/slack/api/apps.connections.open") {
          return Response.json({ ok: true, url: "wss://monitoring.wpcapp.net/slack/socket" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(srv);

    const client = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api`,
      botToken: createFileTokenProvider({ label: "SLACK_BOT_TOKEN_FILE", filePath: botFile }),
      appToken: createFileTokenProvider({ label: "SLACK_APP_TOKEN_FILE", filePath: appFile }),
    });

    await client.authTest();
    expect(await client.openSocketConnection()).toBe("wss://monitoring.wpcapp.net/slack/socket");

    // ローテーション後
    writeFileSync(botFile, "  bot-jwt-v2 \n");
    writeFileSync(appFile, "app-jwt-v2\n");
    await client.postMessage({ channel: "C1", thread_ts: "10.1", text: "hi" });
    await client.openSocketConnection();

    expect(seenAuth).toEqual([
      { path: "/slack/api/auth.test", auth: "Bearer bot-jwt-v1" },
      { path: "/slack/api/apps.connections.open", auth: "Bearer app-jwt-v1" },
      { path: "/slack/api/chat.postMessage", auth: "Bearer bot-jwt-v2" },
      { path: "/slack/api/apps.connections.open", auth: "Bearer app-jwt-v2" },
    ]);

    // 空ファイルになった場合は retryable: false の SlackApiError で即座に失敗する
    writeFileSync(botFile, "");
    const brokenClient = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api`,
      botToken: createFileTokenProvider({
        label: "SLACK_BOT_TOKEN_FILE",
        filePath: botFile,
        maxRetries: 1,
        retryDelayMs: 5,
      }),
      appToken: "app",
    });
    await expect(brokenClient.waitForAuthTest({ initialDelayMs: 10 })).rejects.toThrow(
      /トークン取得に失敗した/,
    );
  });

  test("getThreadReplies は url / details / source_kind / alert_status / level を保持する", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/slack/api/conversations.replies") {
          return Response.json({
            ok: true,
            has_more: false,
            messages: [
              {
                ts: "100.1",
                bot_id: "B_AM",
                username: "alertmanager",
                text: "[firing] HighErrorRate",
                url: "https://prometheus.wpcapp.net/graph?g0.expr=up%3D%3D0",
                details: JSON.stringify({
                  fingerprint: "fp-1",
                  labels: { alertname: "HighErrorRate", instance: "host-a" },
                  annotations: { summary: "errors > 5%" },
                }),
                source_kind: "alert",
                alert_status: "firing",
                level: "critical",
              },
              {
                ts: "100.2",
                user: "U1",
                thread_ts: "100.1",
                text: "確認して",
                url: "",
                details: { custom: "obj-detail" },
              },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(srv);

    const client = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api`,
      botToken: "bot",
      appToken: "app",
    });

    const replies = await client.getThreadReplies("C1", "100.1");
    expect(replies).toEqual([
      {
        ts: "100.1",
        bot_id: "B_AM",
        username: "alertmanager",
        text: "[firing] HighErrorRate",
        url: "https://prometheus.wpcapp.net/graph?g0.expr=up%3D%3D0",
        details: JSON.stringify({
          fingerprint: "fp-1",
          labels: { alertname: "HighErrorRate", instance: "host-a" },
          annotations: { summary: "errors > 5%" },
        }),
        source_kind: "alert",
        alert_status: "firing",
        level: "critical",
      },
      {
        ts: "100.2",
        user: "U1",
        thread_ts: "100.1",
        text: "確認して",
        details: { custom: "obj-detail" },
      },
    ]);
  });

  test("HTTPS ベース URL では ws:// を拒否し、chat.postMessage は通信エラー時に再送しない", async () => {
    let postAttempts = 0;
    const client = new SlackWebClient({
      apiBaseUrl: "https://monitoring.wpcapp.net/slack/api",
      botToken: "bot",
      appToken: "app",
      fetchFn: (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/apps.connections.open")) {
          return Response.json({ ok: true, url: "ws://monitoring.wpcapp.net/slack/socket" });
        }
        if (url.endsWith("/chat.postMessage")) {
          postAttempts++;
          throw new Error("socket closed after server persisted");
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });

    await expect(client.openSocketConnection()).rejects.toMatchObject({
      code: "insecure_ws_url",
      retryable: false,
    });

    await expect(
      client.postMessage({ channel: "C1", thread_ts: "10.1", text: "重複防止テスト" }),
    ).rejects.toMatchObject({
      code: "network_error",
    });
    expect(postAttempts).toBe(1);
  });

  test("getThreadReplies は reply_count を保持する", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          ok: true,
          has_more: false,
          messages: [
            { ts: "100.1", text: "parent", reply_count: 250 },
            { ts: "100.2", thread_ts: "100.1", text: "r1" },
          ],
        });
      },
    });
    servers.push(srv);

    const client = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api`,
      botToken: "bot",
      appToken: "app",
    });
    const replies = await client.getThreadReplies("C1", "100.1");
    expect(replies[0]?.reply_count).toBe(250);
  });
});

describe("SocketModeClient", () => {
  test("hello 受信・events_api の ack・disconnect 再接続・無通信タイムアウト再接続を行う", async () => {
    let openCalls = 0;
    let connCount = 0;
    const acked: string[] = [];
    const receivedEvents: string[] = [];
    const sockets: ServerWebSocket<{ conn: number }>[] = [];

    let port = 0;
    let sm: SocketModeClient | null = null;
    const srv = Bun.serve<{ conn: number }>({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/slack/api/apps.connections.open") {
          openCalls++;
          return Response.json({
            ok: true,
            url: `ws://127.0.0.1:${port}/slack/socket?ticket=t-${openCalls}`,
          });
        }
        if (url.pathname === "/slack/socket") {
          if (server.upgrade(req, { data: { conn: ++connCount } })) return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sockets.push(ws);
          ws.send(JSON.stringify({ type: "hello", num_connections: ws.data.conn }));
          if (ws.data.conn === 1) {
            ws.send(
              JSON.stringify({
                envelope_id: "env-1",
                type: "events_api",
                payload: {
                  type: "event_callback",
                  event: { type: "app_mention", channel: "C1", ts: "10.1", user: "U1", text: "hi" },
                },
              }),
            );
          } else if (ws.data.conn === 2) {
            // 2 回目の接続は完全に無通信にして無通信タイムアウトで切れることを確かめる
          } else if (ws.data.conn === 3) {
            ws.send(
              JSON.stringify({
                envelope_id: "env-3",
                type: "events_api",
                payload: {
                  type: "event_callback",
                  event: { type: "app_mention", channel: "C1", ts: "10.3", user: "U1", text: "ok" },
                },
              }),
            );
          }
        },
        message(ws, raw) {
          const parsed = JSON.parse(String(raw)) as { envelope_id?: string };
          if (parsed.envelope_id) {
            acked.push(parsed.envelope_id);
            if (ws.data.conn === 1) {
              // ack 受領後にサーバーから disconnect を送る
              ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
            } else if (ws.data.conn === 3 && parsed.envelope_id === "env-3") {
              sm?.stop();
            }
          }
        },
      },
    });
    port = srv.port ?? 0;
    servers.push(srv);

    const client = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api`,
      botToken: "xoxb-spiffe",
      appToken: "xapp-spiffe",
    });

    const warnings: string[] = [];
    sm = new SocketModeClient({
      client,
      onEvent: (ev) => {
        if (ev.ts) receivedEvents.push(ev.ts);
      },
      warn: (m) => warnings.push(m),
      pingIntervalMs: 0, // conn 2 の無通信タイムアウトを直接テストするため ping を止める
      inactivityTimeoutMs: 120,
      helloTimeoutMs: 500,
      initialBackoffMs: 20,
      maxBackoffMs: 50,
    });

    await sm.start();

    expect(connCount).toBeGreaterThanOrEqual(3);
    expect(acked).toEqual(["env-1", "env-3"]);
    expect(receivedEvents).toEqual(["10.1", "10.3"]);
    expect(warnings.some((w) => w.includes("無通信タイムアウト"))).toBe(true);
  });

  test("hello 直後の disconnect 繰り返しには指数バックオフが効く", async () => {
    let connCount = 0;
    const openTimes: number[] = [];
    let port = 0;
    let sm: SocketModeClient | null = null;
    const srv = Bun.serve<{ conn: number }>({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/slack/api/apps.connections.open") {
          openTimes.push(Date.now());
          if (openTimes.length >= 4) {
            sm?.stop();
          }
          return Response.json({
            ok: true,
            url: `ws://127.0.0.1:${port}/slack/socket`,
          });
        }
        if (url.pathname === "/slack/socket") {
          if (server.upgrade(req, { data: { conn: ++connCount } })) return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "hello", num_connections: ws.data.conn }));
          ws.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
        },
        message() {},
      },
    });
    port = srv.port ?? 0;
    servers.push(srv);

    const client = new SlackWebClient({
      apiBaseUrl: `http://127.0.0.1:${srv.port}/slack/api`,
      botToken: "bot",
      appToken: "app",
    });

    sm = new SocketModeClient({
      client,
      onEvent: () => {},
      pingIntervalMs: 0,
      inactivityTimeoutMs: 5000,
      helloTimeoutMs: 5000,
      initialBackoffMs: 30,
      maxBackoffMs: 200,
      minStableConnectionMs: 10_000,
    });

    await sm.start();
    expect(openTimes.length).toBeGreaterThanOrEqual(4);
    const gap1 = openTimes[1]! - openTimes[0]!;
    const gap3 = openTimes[3]! - openTimes[2]!;
    // 30ms -> 60ms -> 120ms と待ち時間が伸びていることを確かめる
    expect(gap3).toBeGreaterThan(gap1 * 2);
  });
});
