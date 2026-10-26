import { formatInvocation, type Invocation } from "./agents.ts";
import { type CiVerdict, judgeCi } from "./ci.ts";
import type { GitHub } from "./github.ts";
import type { Assignee, Assignment } from "./models.ts";
import * as prompts from "./prompts.ts";

/**
 * 任された仕事を最後まで進める流れ。
 *
 *   実装 → PR → [CI 待ち ‖ レビュー → 修正] を上限回数まで → 要約
 *
 * 修正ループは、指摘の連鎖で上限まで回らないように絞る。
 * - 1 周目は must と should を直し、2 周目以降は must だけを直す。nit と見送った指摘は要約で人間に渡す
 * - レビューに must が無ければ、直した後に再レビューしない（CI だけ確かめる）
 * - CI 待ちとレビューは同時に進める。レビューは CI の結果を使わない
 * - 修正担当は実装担当の会話の続きで動く。コードを一から読み直さずに済む
 *
 * --from review では実装を飛ばし、今のブランチの PR（--local ならローカルの commit）のレビューから始める。
 *
 * 順序と待ちはここが持ち、判断は LLM に任せる。
 * 成否はエージェントの自己申告ではなく、commit・PR・push が実際にできたかで判定する。
 *
 * 担当はモデルの並びを持ち、失敗したら次のモデルで試し直す（利用上限・認証切れ・モデルの廃止）。
 * ただしコードを書き換える作業は、途中まで書き換えて落ちたなら試し直さない。別のモデルが続きを書くと混ざる。
 */

/** CI の状態を読み直す間隔。 */
export const CI_POLL_MS = 30_000;

/** どこから始めるか。review は実装が済んでいて、レビューだけ回したいとき。 */
export const START_POINTS = ["implement", "review"] as const;
export type StartPoint = (typeof START_POINTS)[number];

export interface Config extends Assignment {
  maxRounds: number;
  baseSha: string;
  from: StartPoint;
}

/** 会話をどう始めるか。start の会話 ID は runAgent が決める（担当ごと・試し直しごとに別の会話になる）。 */
export type SessionPlan = { kind: "start" } | { kind: "resume"; id: string };

export interface AgentRun {
  ok: boolean;
  /** session を渡したときの会話 ID。読めなければ null。 */
  session: string | null;
}

export interface Deps {
  /**
   * エージェントを 1 ターン実行する。
   * output を渡すとその名前で標準出力を保存する。session を渡すと会話を始めるか続け、その ID を返す。
   */
  runAgent(
    inv: Invocation,
    prompt: string,
    opts?: { output?: string; session?: SessionPlan },
  ): Promise<AgentRun>;
  head(): Promise<string>;
  /** 作業ツリーの状態（HEAD・未 commit の変更）を表す値。エージェントが何か変えたかを比べる。 */
  fingerprint(): Promise<string>;
  /** PR と CI。--local のときは null。 */
  github: GitHub | null;
  clock: {
    now(): number;
    sleep(ms: number): Promise<void>;
  };
  state: {
    stage(stage: string): void;
    log(msg: string): void;
    rel(name: string): string;
    file(name: string): string;
    read(name: string): string | null;
    takeInbox(round: number): string | null;
  };
}

export type Outcome =
  | { kind: "done" }
  | { kind: "needs-human"; reason: string }
  | { kind: "failed"; reason: string };

export function formatOutcome(o: Outcome): string {
  return o.kind === "done" ? "done" : `${o.kind}: ${o.reason}`;
}

/** レビュー結果のファイル名。同じエージェントをモデル違いで並べても衝突しない。 */
export function reviewFileName(reviewer: Assignee, round: number): string {
  const slug = reviewer.name.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `review-${round}-${slug}.md`;
}

/** 担当を、モデルの並びの前から順に試す。 */
class Runner {
  /** 失敗したモデル。利用上限は数時間〜数日戻らないので、この実行の間は後回しにする。 */
  private readonly failed = new Set<string>();

  constructor(private readonly d: Deps) {}

  /**
   * @param writes コードを書き換える作業か。書き換えたうえで失敗したら、次のモデルに切り替えない
   */
  async run(
    who: Assignee,
    prompt: string,
    opts: { writes: boolean; output?: string; session?: SessionPlan },
  ): Promise<AgentRun> {
    const failed: AgentRun = { ok: false, session: null };
    const fresh = who.chain.filter((inv) => !this.failed.has(formatInvocation(inv)));
    // 全部が一度失敗していても、あきらめる前にもう一度だけ並びどおりに試す。
    const order = fresh.length > 0 ? fresh : who.chain;
    for (const [i, inv] of order.entries()) {
      const before = opts.writes ? await this.d.fingerprint() : "";
      const r = await this.d.runAgent(inv, prompt, { output: opts.output, session: opts.session });
      if (r.ok) return r;
      this.failed.add(formatInvocation(inv));
      const next = order[i + 1];
      if (!next) break;
      if (opts.writes && (await this.d.fingerprint()) !== before) {
        this.d.state.log(
          `${formatInvocation(inv)} が途中まで書き換えて失敗した。続きが混ざるので次のモデルには切り替えない`,
        );
        return failed;
      }
      this.d.state.log(`${formatInvocation(inv)} が失敗した。${formatInvocation(next)} で試し直す`);
    }
    return failed;
  }
}

/**
 * 実装と修正の担当。修正は実装の会話の続きで行う。
 * 会話 ID が読めなかったときは、次の修正を新しい会話で始める（ログに残す）。
 */
class Writer {
  private session: string | null = null;

  constructor(
    private readonly d: Deps,
    private readonly runner: Runner,
  ) {}

  async run(who: Assignee, prompt: string): Promise<boolean> {
    const plan: SessionPlan = this.session
      ? { kind: "resume", id: this.session }
      : { kind: "start" };
    const r = await this.runner.run(who, prompt, { writes: true, session: plan });
    if (r.ok && !r.session)
      this.d.state.log("会話 ID を読めなかった。次の修正は新しい会話で始める");
    this.session = r.ok ? r.session : this.session;
    return r.ok;
  }
}

export async function runPipeline(cfg: Config, d: Deps): Promise<Outcome> {
  const mode: prompts.ShipMode = d.github ? "pr" : "local";
  const runner = new Runner(d);
  const writer = new Writer(d, runner);

  if (cfg.from === "implement") {
    d.state.stage(`implementing (${cfg.implement.name})`);
    // 基点ではなく実装の直前と比べる。既存の PR の続きでは、もとから基点より進んでいる。
    const beforeImplement = await d.head();
    if (!(await writer.run(cfg.implement, prompts.implement(mode)))) {
      return { kind: "failed", reason: "実装担当が異常終了した" };
    }
    if ((await d.head()) === beforeImplement) {
      return { kind: "failed", reason: "何も commit されなかった" };
    }
  }

  let pr: number | null = null;
  if (d.github) {
    pr = await d.github.prNumber();
    if (pr === null) {
      return {
        kind: "failed",
        reason: cfg.from === "implement" ? "PR が作られなかった" : "PR が無い",
      };
    }
    d.state.log(`PR #${pr}`);
  }

  const outcome = await rounds(cfg, d, runner, writer, mode, pr);
  if (outcome.kind === "failed") return outcome;

  d.state.stage("summarizing");
  // 要約はコードを書き換えない（result.md と PR 本文だけ）ので、何度試し直してもよい。
  if (
    !(await runner.run(cfg.summarize, prompts.summarize(cfg.baseSha, pr), { writes: false })).ok
  ) {
    d.state.log("要約担当が異常終了した");
  }
  return outcome;
}

async function rounds(
  cfg: Config,
  d: Deps,
  runner: Runner,
  writer: Writer,
  mode: prompts.ShipMode,
  pr: number | null,
): Promise<Outcome> {
  /** 今の HEAD にレビューが要るか。must の無いレビューの後の修正は、CI だけ確かめる。 */
  let needsReview = true;
  /** 前回レビューした HEAD。2 周目以降のレビューは、ここからの修正を中心に見る。 */
  let reviewedAt: string | null = null;

  for (let round = 1; round <= cfg.maxRounds; round++) {
    const head = await d.head();
    const github = d.github && pr !== null ? { gh: d.github, pr } : null;
    const names = cfg.reviewers.map((r) => r.name).join(", ");
    const waiting = [
      needsReview && `reviewing (round ${round}: ${names})`,
      github && (needsReview ? "waiting CI" : `waiting CI (round ${round})`),
    ].filter(Boolean);
    // --local で must の無い修正の後は、待つものが無い。
    if (waiting.length > 0) d.state.stage(waiting.join(" + "));

    // レビューは CI の結果を使わないので、CI を待つ間に進める。
    const [ci, reviews]: [CiVerdict | null, string[] | null] = await Promise.all([
      github ? waitCi(d, github.gh, github.pr) : null,
      needsReview ? review(cfg, d, runner, round, reviewedAt) : null,
    ]);

    let ciLog: string | null = null;
    if (github && ci) {
      d.state.log(`CI: ${ci.kind}`);
      if (ci.kind === "unpushed") {
        return {
          kind: "failed",
          reason: "commit が push されていない（PR の HEAD がローカルと違う）",
        };
      }
      if (ci.kind === "stalled") {
        return { kind: "needs-human", reason: "CI が終わらない" };
      }
      if (ci.kind === "fail") {
        const name = `ci-fail-${round}.log`;
        await github.gh.saveFailedLog(head, d.state.file(name));
        ciLog = d.state.rel(name);
      }
    }

    if (reviews !== null && reviews.length === 0) {
      return { kind: "needs-human", reason: "レビュー担当が全員失敗した" };
    }
    if (reviews !== null) reviewedAt = head;
    const must = (reviews ?? []).some((name) => prompts.reviewHasMust(d.state.read(name) ?? ""));

    const inboxName = d.state.takeInbox(round);
    const inbox = inboxName ? d.state.rel(inboxName) : null;

    if (!must && ciLog === null && inbox === null) {
      if (reviews === null) {
        d.state.log("前の修正は must ではないので、CI だけ確かめて再レビューせずに終える");
        return { kind: "done" };
      }
      if (round > 1) {
        d.state.log("レビューに must が無いので、何も直さずに終える");
        return { kind: "done" };
      }
    }

    d.state.stage(`fixing (round ${round})`);
    const prompt = prompts.fix({
      mode,
      scope: round === 1 ? "must-should" : "must",
      reviews: (reviews ?? []).map((name) => d.state.rel(name)),
      ciLog,
      inbox,
    });
    if (!(await writer.run(cfg.fix, prompt))) {
      return { kind: "failed", reason: "修正担当が異常終了した" };
    }

    if ((await d.head()) === head) {
      return ciLog ? { kind: "needs-human", reason: "CI の失敗を直せなかった" } : { kind: "done" };
    }
    // CI だけを直した修正は、CI が通れば足りる。
    needsReview = must || inbox !== null;
    if (!needsReview) d.state.log("must の無い修正なので、次は CI だけ確かめる");
  }
  return {
    kind: "needs-human",
    reason: `修正ループが上限（${cfg.maxRounds} 回）に達した。${needsReview ? "最後の修正は未レビュー" : "最後の修正の CI を確かめていない"}`,
  };
}

/** レビュー担当を全員並べて走らせ、書けたレビューのファイル名を返す。 */
async function review(
  cfg: Config,
  d: Deps,
  runner: Runner,
  round: number,
  since: string | null,
): Promise<string[]> {
  const results = await Promise.all(
    cfg.reviewers.map(async (rv) => {
      const name = reviewFileName(rv, round);
      // レビュー担当はファイルを書き換えないので、失敗したら常に次のモデルで試し直す。
      const r = await runner.run(rv, prompts.review({ baseSha: cfg.baseSha, since }), {
        writes: false,
        output: name,
      });
      if (!r.ok) d.state.log(`レビュー失敗: ${rv.name}`);
      return r.ok ? name : null;
    }),
  );
  return results.filter((r): r is string => r !== null);
}

/** CI の判定が出るまで待つ。判定そのものは judgeCi に任せる。 */
async function waitCi(d: Deps, github: GitHub, pr: number): Promise<CiVerdict> {
  const start = d.clock.now();
  let lastWhy = "";
  for (;;) {
    let snap = null;
    try {
      snap = await github.snapshot(pr);
    } catch (e) {
      d.state.log(e instanceof Error ? e.message : String(e));
    }
    const v = judgeCi(snap, await d.head(), d.clock.now() - start);
    if (v.kind !== "wait") return v;
    if (v.why !== lastWhy) d.state.log(`CI 待ち: ${v.why}`);
    lastWhy = v.why;
    await d.clock.sleep(CI_POLL_MS);
  }
}
