export interface SlackEvent {
  type: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  [key: string]: unknown;
}

export interface BotIdentity {
  userId: string;
  botId: string | null;
  userName: string | null;
}

export type TriggerKind = "app_mention" | "thread_reply";

export interface RouteDecision {
  kind: TriggerKind;
  channel: string;
  threadTs: string;
  messageTs: string;
  event: SlackEvent;
}

export interface RouteContext {
  identity: BotIdentity;
  isParticipatingThread: (channel: string, threadTs: string) => boolean;
  hasProcessedMessage?: (channel: string, threadTs: string, messageTs: string) => boolean;
}

/**
 * 将来 #alertmanager 通知など自動発火ルールを増やしやすいよう、
 * 判定関数（RouteRule）を並べて評価する構成にする。
 */
export type RouteRule = (event: SlackEvent, ctx: RouteContext) => RouteDecision | null;

export function resolveThreadTs(event: Pick<SlackEvent, "ts" | "thread_ts">): string {
  return (typeof event.thread_ts === "string" && event.thread_ts) || event.ts || "";
}

export const appMentionRule: RouteRule = (event) => {
  if (event.type !== "app_mention") return null;
  if (!event.channel || !event.ts) return null;
  return {
    kind: "app_mention",
    channel: event.channel,
    threadTs: resolveThreadTs(event),
    messageTs: event.ts,
    event,
  };
};

export const participatingThreadReplyRule: RouteRule = (event, ctx) => {
  if (event.type !== "message") return null;
  if (!event.channel || !event.ts) return null;
  const threadTs = resolveThreadTs(event);
  if (!ctx.isParticipatingThread(event.channel, threadTs)) return null;
  return {
    kind: "thread_reply",
    channel: event.channel,
    threadTs,
    messageTs: event.ts,
    event,
  };
};

export const DEFAULT_ROUTE_RULES: readonly RouteRule[] = [
  appMentionRule,
  participatingThreadReplyRule,
];

export interface EventRouterOptions {
  rules?: readonly RouteRule[];
  maxDedupEntries?: number;
  dedupTtlMs?: number;
}

/**
 * Slack イベントの自己ループ防止・重複排除・ルーティングを行う。
 */
export class EventRouter {
  private readonly rules: readonly RouteRule[];
  private readonly maxDedupEntries: number;
  private readonly dedupTtlMs: number;
  private readonly seen = new Map<string, number>();

  constructor(options: EventRouterOptions = {}) {
    this.rules = options.rules ?? DEFAULT_ROUTE_RULES;
    this.maxDedupEntries = options.maxDedupEntries ?? 5000;
    this.dedupTtlMs = options.dedupTtlMs ?? 60 * 60 * 1000;
  }

  route(event: SlackEvent, ctx: RouteContext, nowMs = Date.now()): RouteDecision | null {
    if (typeof event.channel !== "string" || !event.channel) return null;
    if (typeof event.ts !== "string" || !event.ts) return null;

    // 自分自身・他の bot・編集等の subtype は反応対象にしない。
    if (event.bot_id) return null;
    if (event.subtype) return null;
    if (event.user && event.user === ctx.identity.userId) return null;

    const dedupKey = `${event.channel}:${event.ts}`;
    this.pruneSeen(nowMs);
    if (this.seen.has(dedupKey)) return null;

    const threadTs = resolveThreadTs(event);
    if (ctx.hasProcessedMessage?.(event.channel, threadTs, event.ts)) {
      this.recordSeen(dedupKey, nowMs);
      return null;
    }

    for (const rule of this.rules) {
      const decision = rule(event, ctx);
      if (decision) {
        this.recordSeen(dedupKey, nowMs);
        return decision;
      }
    }
    return null;
  }

  private recordSeen(key: string, nowMs: number): void {
    this.seen.set(key, nowMs);
    while (this.seen.size > this.maxDedupEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  private pruneSeen(nowMs: number): void {
    const cutoff = nowMs - this.dedupTtlMs;
    for (const [k, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(k);
      } else {
        // Map は挿入順なので、期限内の最初の要素が出たら打ち切る。
        break;
      }
    }
  }
}
