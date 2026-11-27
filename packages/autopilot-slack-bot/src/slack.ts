import type { TokenProvider } from "./config.ts";
import type { SlackThreadMessage } from "./prompt.ts";
import type { BotIdentity, SlackEvent } from "./router.ts";

const FATAL_SLACK_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "invalid_arg_name",
  "missing_scope",
  "channel_not_found",
  "thread_not_found",
  "unknown_method",
]);

export class SlackApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts: { code: string; status?: number; retryable: boolean }) {
    super(message);
    this.name = "SlackApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

export interface SlackWebClientOptions {
  apiBaseUrl: string;
  botToken: string | TokenProvider;
  appToken: string | TokenProvider;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

function toTokenProvider(tokenOrProvider: string | TokenProvider): TokenProvider {
  return typeof tokenOrProvider === "function" ? tokenOrProvider : async () => tokenOrProvider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (ms <= 0) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bun 標準の fetch を使った Slack App 互換 Web API クライアント。
 */
export class SlackWebClient {
  readonly apiBaseUrl: string;
  private readonly botTokenProvider: TokenProvider;
  private readonly appTokenProvider: TokenProvider;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: SlackWebClientOptions) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.botTokenProvider = toTokenProvider(opts.botToken);
    this.appTokenProvider = toTokenProvider(opts.appToken);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  private async callApi(
    method: string,
    getToken: TokenProvider,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    let token: string;
    try {
      token = (await getToken()).trim();
      if (!token) {
        throw new Error("トークンが空である");
      }
    } catch (e) {
      throw new SlackApiError(
        `${method}: トークン取得に失敗した (${e instanceof Error ? e.message : String(e)})`,
        { code: "token_read_error", retryable: false },
      );
    }

    const url = `${this.apiBaseUrl}/${method}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new SlackApiError(
        `${method}: 通信に失敗した (${e instanceof Error ? e.message : String(e)})`,
        { code: "network_error", retryable: true },
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      const retryable = res.status >= 500 || res.status === 429;
      throw new SlackApiError(`${method}: JSON 応答の解析に失敗した (HTTP ${res.status})`, {
        code: "invalid_json",
        status: res.status,
        retryable,
      });
    }

    if (!res.ok) {
      const errCode =
        isRecord(data) && typeof data.error === "string" ? data.error : `http_${res.status}`;
      const retryable = res.status >= 500 || res.status === 429;
      throw new SlackApiError(`${method}: HTTP ${res.status} (${errCode})`, {
        code: errCode,
        status: res.status,
        retryable,
      });
    }

    if (!isRecord(data) || data.ok !== true) {
      const errCode =
        isRecord(data) && typeof data.error === "string" ? data.error : "unknown_error";
      const retryable =
        !FATAL_SLACK_ERRORS.has(errCode) &&
        (errCode === "internal_error" || errCode === "ratelimited");
      throw new SlackApiError(`${method}: Slack API エラー (${errCode})`, {
        code: errCode,
        status: res.status,
        retryable,
      });
    }

    return data;
  }

  private async callWithRetry(
    method: string,
    getToken: TokenProvider,
    body: Record<string, unknown>,
    maxRetries = 2,
    retryDelayMs = 500,
  ): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.callApi(method, getToken, body);
      } catch (e) {
        lastError = e;
        if (!(e instanceof SlackApiError) || !e.retryable || attempt === maxRetries) {
          throw e;
        }
        await Bun.sleep(retryDelayMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async authTest(): Promise<BotIdentity> {
    const data = await this.callApi("auth.test", this.botTokenProvider);
    if (typeof data.user_id !== "string" || !data.user_id) {
      throw new SlackApiError("auth.test: user_id が応答に含まれていない", {
        code: "invalid_response",
        retryable: false,
      });
    }
    return {
      userId: data.user_id,
      botId: typeof data.bot_id === "string" && data.bot_id ? data.bot_id : null,
      userName: typeof data.user === "string" && data.user ? data.user : null,
    };
  }

  /** 起動時に接続先が未準備の間はバックオフ付きで auth.test をリトライする。 */
  async waitForAuthTest(
    opts: {
      initialDelayMs?: number;
      maxDelayMs?: number;
      signal?: AbortSignal;
      onRetry?: (err: unknown, delayMs: number) => void;
    } = {},
  ): Promise<BotIdentity> {
    const initialDelayMs = opts.initialDelayMs ?? 1000;
    const maxDelayMs = opts.maxDelayMs ?? 30_000;
    let delayMs = initialDelayMs;

    while (true) {
      if (opts.signal?.aborted) {
        throw new Error("auth.test 待機が中断された");
      }
      try {
        return await this.authTest();
      } catch (e) {
        if (e instanceof SlackApiError && !e.retryable) {
          throw e;
        }
        opts.onRetry?.(e, delayMs);
        const ok = await sleepWithAbort(delayMs, opts.signal);
        if (!ok) throw new Error("auth.test 待機が中断された");
        delayMs = Math.min(delayMs * 2, maxDelayMs);
      }
    }
  }

  async openSocketConnection(): Promise<string> {
    const data = await this.callApi("apps.connections.open", this.appTokenProvider);
    if (typeof data.url !== "string" || !data.url) {
      throw new SlackApiError("apps.connections.open: url が応答に含まれていない", {
        code: "invalid_response",
        retryable: false,
      });
    }
    return data.url;
  }

  async getThreadReplies(channel: string, ts: string): Promise<SlackThreadMessage[]> {
    const messages: SlackThreadMessage[] = [];
    let cursor = "";

    for (let page = 0; page < 10; page++) {
      const body: Record<string, unknown> = { channel, ts, limit: 200 };
      if (cursor) body.cursor = cursor;
      const data = await this.callWithRetry("conversations.replies", this.botTokenProvider, body);
      if (Array.isArray(data.messages)) {
        for (const item of data.messages) {
          if (isRecord(item) && typeof item.ts === "string") {
            messages.push({
              ts: item.ts,
              ...(typeof item.user === "string" ? { user: item.user } : {}),
              ...(typeof item.bot_id === "string" ? { bot_id: item.bot_id } : {}),
              ...(typeof item.username === "string" ? { username: item.username } : {}),
              ...(typeof item.text === "string" ? { text: item.text } : {}),
              ...(typeof item.thread_ts === "string" ? { thread_ts: item.thread_ts } : {}),
              ...(typeof item.url === "string" && item.url ? { url: item.url } : {}),
              ...(typeof item.details === "string" && item.details
                ? { details: item.details }
                : isRecord(item.details)
                  ? { details: item.details }
                  : {}),
              ...(typeof item.source_kind === "string" && item.source_kind
                ? { source_kind: item.source_kind }
                : {}),
              ...(typeof item.alert_status === "string" && item.alert_status
                ? { alert_status: item.alert_status }
                : {}),
              ...(typeof item.level === "string" && item.level ? { level: item.level } : {}),
            });
          }
        }
      }
      const nextCursor =
        isRecord(data.response_metadata) && typeof data.response_metadata.next_cursor === "string"
          ? data.response_metadata.next_cursor.trim()
          : "";
      if (!data.has_more || !nextCursor) break;
      cursor = nextCursor;
    }

    return messages;
  }

  async postMessage(params: {
    channel: string;
    thread_ts?: string;
    text: string;
  }): Promise<{ channel: string; ts: string }> {
    const body: Record<string, unknown> = {
      channel: params.channel,
      text: params.text,
    };
    if (params.thread_ts) body.thread_ts = params.thread_ts;
    const data = await this.callWithRetry("chat.postMessage", this.botTokenProvider, body);
    return {
      channel: typeof data.channel === "string" ? data.channel : params.channel,
      ts: typeof data.ts === "string" ? data.ts : "",
    };
  }
}

export interface SocketModeClientOptions {
  client: SlackWebClient;
  onEvent: (event: SlackEvent) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  pingIntervalMs?: number;
  inactivityTimeoutMs?: number;
  helloTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  createWebSocket?: (url: string) => WebSocket;
}

interface ConnectOutcome {
  helloReceived: boolean;
  disconnectRequested: boolean;
}

type PingableWebSocket = WebSocket & { ping?: () => void };

/**
 * Slack Socket Mode WebSocket クライアント。
 * - apps.connections.open が返した URL へそのまま直接接続する
 * - hello 受信・events_api の envelope_id ack 応答・ping 維持
 * - disconnect 受信・切断・無通信タイムアウト時の指数バックオフ付き再接続
 */
export class SocketModeClient {
  private readonly client: SlackWebClient;
  private readonly onEvent: (event: SlackEvent) => void;
  private readonly log: (msg: string) => void;
  private readonly warn: (msg: string) => void;
  private readonly pingIntervalMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly createWebSocket: (url: string) => WebSocket;

  private stopController = new AbortController();
  private activeWs: WebSocket | null = null;
  private stopped = false;

  constructor(opts: SocketModeClientOptions) {
    this.client = opts.client;
    this.onEvent = opts.onEvent;
    this.log = opts.log ?? (() => {});
    this.warn = opts.warn ?? (() => {});
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000;
    this.inactivityTimeoutMs = opts.inactivityTimeoutMs ?? 90_000;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
    this.initialBackoffMs = opts.initialBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.createWebSocket = opts.createWebSocket ?? ((url) => new WebSocket(url));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    const ws = this.activeWs;
    if (ws) {
      try {
        ws.close(1000, "shutdown");
      } catch {}
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.stopController = new AbortController();
    let backoffMs = this.initialBackoffMs;

    while (!this.stopped) {
      let wsUrl: string;
      try {
        wsUrl = await this.client.openSocketConnection();
      } catch (e) {
        if (e instanceof SlackApiError && !e.retryable) {
          throw e;
        }
        this.warn(
          `apps.connections.open に失敗 (${e instanceof Error ? e.message : String(e)})。${backoffMs}ms 後に再試行する`,
        );
        const ok = await sleepWithAbort(backoffMs, this.stopController.signal);
        if (!ok) break;
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        continue;
      }

      if (this.stopped) break;

      const outcome = await this.connectOnce(wsUrl);
      if (this.stopped) break;

      if (outcome.helloReceived) {
        backoffMs = this.initialBackoffMs;
      }

      if (outcome.disconnectRequested) {
        this.log("disconnect 指示により再接続する");
        const ok = await sleepWithAbort(
          Math.min(this.initialBackoffMs, 200),
          this.stopController.signal,
        );
        if (!ok) break;
        continue;
      }

      const jitter = Math.floor(backoffMs * 0.2 * Math.random());
      const waitMs = backoffMs + jitter;
      this.warn(`Socket Mode 切断。${waitMs}ms 後に再接続する`);
      const ok = await sleepWithAbort(waitMs, this.stopController.signal);
      if (!ok) break;
      backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
    }
  }

  private async connectOnce(wsUrl: string): Promise<ConnectOutcome> {
    return await new Promise<ConnectOutcome>((resolve) => {
      let settled = false;
      let helloReceived = false;
      let disconnectRequested = false;

      let ws: WebSocket;
      try {
        ws = this.createWebSocket(wsUrl);
      } catch (e) {
        this.warn(`WebSocket 初期化に失敗: ${e instanceof Error ? e.message : String(e)}`);
        resolve({ helloReceived: false, disconnectRequested: false });
        return;
      }
      this.activeWs = ws;

      let helloTimer: ReturnType<typeof setTimeout> | undefined;
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
      let pingTimer: ReturnType<typeof setInterval> | undefined;

      const clearTimers = () => {
        if (helloTimer) clearTimeout(helloTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (pingTimer) clearInterval(pingTimer);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (this.activeWs === ws) this.activeWs = null;
        resolve({ helloReceived, disconnectRequested });
      };

      const closeSocket = (code = 1000, reason = "reconnect") => {
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(code, reason);
          }
        } catch {}
        finish();
      };

      const resetInactivity = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (this.inactivityTimeoutMs > 0) {
          inactivityTimer = setTimeout(() => {
            this.warn(
              `Socket Mode 無通信タイムアウト (${this.inactivityTimeoutMs}ms) のため切断する`,
            );
            closeSocket(4000, "inactivity_timeout");
          }, this.inactivityTimeoutMs);
        }
      };

      if (this.helloTimeoutMs > 0) {
        helloTimer = setTimeout(() => {
          if (!helloReceived) {
            this.warn(`Socket Mode hello タイムアウト (${this.helloTimeoutMs}ms)`);
            closeSocket(4001, "hello_timeout");
          }
        }, this.helloTimeoutMs);
      }
      resetInactivity();

      ws.addEventListener("open", () => {
        resetInactivity();
        if (this.pingIntervalMs > 0) {
          pingTimer = setInterval(() => {
            const pws = ws as PingableWebSocket;
            if (ws.readyState === WebSocket.OPEN && typeof pws.ping === "function") {
              try {
                pws.ping();
              } catch {}
            }
          }, this.pingIntervalMs);
        }
      });

      ws.addEventListener("pong", () => {
        resetInactivity();
      });

      ws.addEventListener("message", (ev) => {
        resetInactivity();
        const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          this.warn("Socket Mode: JSON でないメッセージを受信した");
          return;
        }
        if (!isRecord(msg) || typeof msg.type !== "string") return;

        if (msg.type === "hello") {
          helloReceived = true;
          if (helloTimer) clearTimeout(helloTimer);
          this.log("Socket Mode hello を受信した");
          return;
        }

        if (msg.type === "disconnect") {
          disconnectRequested = true;
          const reason = typeof msg.reason === "string" ? msg.reason : "unknown";
          this.log(`Socket Mode disconnect を受信した (reason=${reason})`);
          closeSocket(1000, "server_disconnect");
          return;
        }

        if (msg.type === "events_api") {
          if (typeof msg.envelope_id === "string" && msg.envelope_id) {
            try {
              ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
            } catch (e) {
              this.warn(`ack 送信失敗: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          const payload = msg.payload;
          if (
            isRecord(payload) &&
            payload.type === "event_callback" &&
            isRecord(payload.event) &&
            typeof payload.event.type === "string"
          ) {
            try {
              this.onEvent(payload.event as SlackEvent);
            } catch (e) {
              this.warn(`イベント処理エラー: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      });

      ws.addEventListener("error", () => {
        this.warn("Socket Mode WebSocket エラー");
        finish();
      });

      ws.addEventListener("close", () => {
        finish();
      });
    });
  }
}
