import { describe, expect, test } from "bun:test";
import {
  type BotIdentity,
  DEFAULT_ROUTE_RULES,
  EventRouter,
  type RouteContext,
  type RouteRule,
} from "./router.ts";

const identity: BotIdentity = {
  userId: "U_BOT_DYNAMIC",
  botId: "B_BOT_DYNAMIC",
  userName: "autopilot-bot",
};

function makeCtx(participating: Set<string>): RouteContext {
  return {
    identity,
    isParticipatingThread: (ch, ts) => participating.has(`${ch}:${ts}`),
  };
}

describe("EventRouter", () => {
  test("app_mention は親投稿・スレッド内どちらも対象にする", () => {
    const router = new EventRouter();
    const ctx = makeCtx(new Set());

    const parent = router.route(
      { type: "app_mention", channel: "C01", user: "U_HUMAN", ts: "100.1", text: "<@U_BOT> hi" },
      ctx,
    );
    expect(parent).toMatchObject({
      kind: "app_mention",
      channel: "C01",
      threadTs: "100.1",
      messageTs: "100.1",
    });

    const reply = router.route(
      {
        type: "app_mention",
        channel: "C01",
        user: "U_HUMAN",
        ts: "100.2",
        thread_ts: "100.1",
        text: "<@U_BOT> check",
      },
      ctx,
    );
    expect(reply).toMatchObject({
      kind: "app_mention",
      channel: "C01",
      threadTs: "100.1",
      messageTs: "100.2",
    });
  });

  test("参加済みスレッドへの人間からの後続返信はメンション無しでも拾う", () => {
    const router = new EventRouter();
    const ctx = makeCtx(new Set(["C01:100.1"]));

    expect(
      router.route(
        {
          type: "message",
          channel: "C01",
          user: "U_HUMAN",
          ts: "100.3",
          thread_ts: "100.1",
          text: "ログも見せて",
        },
        ctx,
      ),
    ).toMatchObject({
      kind: "thread_reply",
      channel: "C01",
      threadTs: "100.1",
      messageTs: "100.3",
    });

    // 未参加スレッドの通常メッセージは無視する
    expect(
      router.route(
        {
          type: "message",
          channel: "C01",
          user: "U_HUMAN",
          ts: "200.2",
          thread_ts: "200.1",
          text: "雑談",
        },
        ctx,
      ),
    ).toBeNull();
  });

  test("自分自身・他の bot・subtype 付きメッセージには反応しない", () => {
    const router = new EventRouter();
    const ctx = makeCtx(new Set(["C01:100.1"]));

    expect(
      router.route(
        {
          type: "message",
          channel: "C01",
          user: "U_BOT_DYNAMIC",
          ts: "100.2",
          thread_ts: "100.1",
          text: "self",
        },
        ctx,
      ),
    ).toBeNull();
    expect(
      router.route(
        {
          type: "message",
          channel: "C01",
          user: "U_OTHER_BOT",
          bot_id: "B_ALERT",
          ts: "100.3",
          thread_ts: "100.1",
          text: "[firing]",
        },
        ctx,
      ),
    ).toBeNull();
    expect(
      router.route(
        {
          type: "app_mention",
          channel: "C01",
          user: "U_OTHER_BOT",
          bot_id: "B_OTHER",
          ts: "100.4",
          text: "<@U_BOT_DYNAMIC> loop",
        },
        ctx,
      ),
    ).toBeNull();
    expect(
      router.route(
        {
          type: "message",
          channel: "C01",
          user: "U_HUMAN",
          subtype: "message_changed",
          ts: "100.5",
          thread_ts: "100.1",
          text: "edited",
        },
        ctx,
      ),
    ).toBeNull();
  });

  test("同一 ts で message と app_mention が両方来ても配信順に関わらず 1 回だけ処理する", () => {
    const router = new EventRouter();

    // 1. 未参加スレッドで message -> app_mention の順（monitoring-pwa hub.go と同順）
    const ctxUnjoined = makeCtx(new Set());
    const evMsg = {
      type: "message",
      channel: "C01",
      user: "U_HUMAN",
      ts: "300.1",
      text: "<@U_BOT_DYNAMIC> 調べて",
    };
    const evMention = { ...evMsg, type: "app_mention" };
    expect(router.route(evMsg, ctxUnjoined)).toBeNull();
    expect(router.route(evMention, ctxUnjoined)?.kind).toBe("app_mention");
    // 再送は重複排除される
    expect(router.route(evMention, ctxUnjoined)).toBeNull();

    // 2. 参加済みスレッドで message -> app_mention の順
    const ctxJoined = makeCtx(new Set(["C01:400.1"]));
    const evJoinedMsg = {
      type: "message",
      channel: "C01",
      user: "U_HUMAN",
      ts: "400.2",
      thread_ts: "400.1",
      text: "<@U_BOT_DYNAMIC> 追加確認",
    };
    const evJoinedMention = { ...evJoinedMsg, type: "app_mention" };
    expect(router.route(evJoinedMsg, ctxJoined)?.kind).toBe("thread_reply");
    expect(router.route(evJoinedMention, ctxJoined)).toBeNull();

    // 3. app_mention -> message の順
    const evReverseMention = {
      type: "app_mention",
      channel: "C01",
      user: "U_HUMAN",
      ts: "400.3",
      thread_ts: "400.1",
      text: "<@U_BOT_DYNAMIC> もう一度",
    };
    const evReverseMsg = { ...evReverseMention, type: "message" };
    expect(router.route(evReverseMention, ctxJoined)?.kind).toBe("app_mention");
    expect(router.route(evReverseMsg, ctxJoined)).toBeNull();
  });

  test("拡張ルールを差し込むことで将来の自動発火へ広げられる", () => {
    const alertRule: RouteRule = (ev) => {
      if (
        ev.type === "message" &&
        ev.channel === "C_ALERT" &&
        ev.text?.includes("[firing]") &&
        ev.ts
      ) {
        return {
          kind: "thread_reply",
          channel: ev.channel,
          threadTs: ev.thread_ts || ev.ts,
          messageTs: ev.ts,
          event: ev,
        };
      }
      return null;
    };
    const router = new EventRouter({ rules: [...DEFAULT_ROUTE_RULES, alertRule] });
    const res = router.route(
      {
        type: "message",
        channel: "C_ALERT",
        user: "U_HUMAN",
        ts: "500.1",
        text: "[firing] HighMemory",
      },
      makeCtx(new Set()),
    );
    expect(res?.messageTs).toBe("500.1");
  });

  test("hasProcessedMessage が true のイベントは再起動後の再配信でも除外する", () => {
    const router = new EventRouter();
    const ctx: RouteContext = {
      identity,
      isParticipatingThread: () => true,
      hasProcessedMessage: (_ch, threadTs, msgTs) => threadTs === "100.1" && msgTs === "100.2",
    };

    expect(
      router.route(
        {
          type: "app_mention",
          channel: "C01",
          user: "U_HUMAN",
          ts: "100.2",
          thread_ts: "100.1",
          text: "<@U_BOT_DYNAMIC> もう処理済み",
        },
        ctx,
      ),
    ).toBeNull();

    expect(
      router.route(
        {
          type: "message",
          channel: "C01",
          user: "U_HUMAN",
          ts: "100.3",
          thread_ts: "100.1",
          text: "未処理の返信",
        },
        ctx,
      )?.messageTs,
    ).toBe("100.3");
  });
});
