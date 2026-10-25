import { formatInvocation, type Invocation } from "./agents.ts";
import { type CiVerdict, judgeCi } from "./ci.ts";
import type { GitHub } from "./github.ts";
import type { Assignee, Assignment } from "./models.ts";
import * as prompts from "./prompts.ts";

/**
 * 任された仕事を最後まで進める流れ。
 *
 *   実装 → PR → [CI 待ち → レビュー → 修正] を上限回数まで → 要約
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

export interface Deps {
  /** エージェントを 1 ターン実行する。outputName を渡すとその名前で標準出力を保存する。 */
  runAgent(inv: Invocation, prompt: string, outputName?: string): Promise<boolean>;
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
    opts: { writes: boolean; output?: string },
  ): Promise<boolean> {
    const fresh = who.chain.filter((inv) => !this.failed.has(formatInvocation(inv)));
    // 全部が一度失敗していても、あきらめる前にもう一度だけ並びどおりに試す。
    const order = fresh.length > 0 ? fresh : who.chain;
    for (const [i, inv] of order.entries()) {
      const before = opts.writes ? await this.d.fingerprint() : "";
      if (await this.d.runAgent(inv, prompt, opts.output)) return true;
      this.failed.add(formatInvocation(inv));
      const next = order[i + 1];
      if (!next) break;
      if (opts.writes && (await this.d.fingerprint()) !== before) {
        this.d.state.log(
          `${formatInvocation(inv)} が途中まで書き換えて失敗した。続きが混ざるので次のモデルには切り替えない`,
        );
        return false;
      }
      this.d.state.log(`${formatInvocation(inv)} が失敗した。${formatInvocation(next)} で試し直す`);
    }
    return false;
  }
}

export async function runPipeline(cfg: Config, d: Deps): Promise<Outcome> {
  const mode: prompts.ShipMode = d.github ? "pr" : "local";
  const runner = new Runner(d);

  if (cfg.from === "implement") {
    d.state.stage(`implementing (${cfg.implement.name})`);
    // 基点ではなく実装の直前と比べる。既存の PR の続きでは、もとから基点より進んでいる。
    const beforeImplement = await d.head();
    if (!(await runner.run(cfg.implement, prompts.implement(mode), { writes: true }))) {
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

  const outcome = await rounds(cfg, d, runner, mode, pr);
  if (outcome.kind === "failed") return outcome;

  d.state.stage("summarizing");
  // 要約はコードを書き換えない（result.md と PR 本文だけ）ので、何度試し直してもよい。
  if (!(await runner.run(cfg.summarize, prompts.summarize(cfg.baseSha, pr), { writes: false }))) {
    d.state.log("要約担当が異常終了した");
  }
  return outcome;
}

async function rounds(
  cfg: Config,
  d: Deps,
  runner: Runner,
  mode: prompts.ShipMode,
  pr: number | null,
): Promise<Outcome> {
  for (let round = 1; round <= cfg.maxRounds; round++) {
    let ciLog: string | null = null;
    if (d.github && pr !== null) {
      d.state.stage(`waiting CI (round ${round})`);
      const ci = await waitCi(d, d.github, pr);
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
        await d.github.saveFailedLog(await d.head(), d.state.file(name));
        ciLog = d.state.rel(name);
      }
    }

    d.state.stage(`reviewing (round ${round}: ${cfg.reviewers.map((r) => r.name).join(", ")})`);
    const results = await Promise.all(
      cfg.reviewers.map(async (rv) => {
        const name = reviewFileName(rv, round);
        // レビュー担当はファイルを書き換えないので、失敗したら常に次のモデルで試し直す。
        const ok = await runner.run(rv, prompts.review(cfg.baseSha), {
          writes: false,
          output: name,
        });
        if (!ok) d.state.log(`レビュー失敗: ${rv.name}`);
        return ok ? d.state.rel(name) : null;
      }),
    );
    const reviews = results.filter((r): r is string => r !== null);
    if (reviews.length === 0) {
      return { kind: "needs-human", reason: "レビュー担当が全員失敗した" };
    }

    const inboxName = d.state.takeInbox(round);
    const inbox = inboxName ? d.state.rel(inboxName) : null;

    d.state.stage(`fixing (round ${round})`);
    const before = await d.head();
    if (
      !(await runner.run(cfg.fix, prompts.fix({ mode, reviews, ciLog, inbox }), { writes: true }))
    ) {
      return { kind: "failed", reason: "修正担当が異常終了した" };
    }

    if ((await d.head()) === before) {
      return ciLog ? { kind: "needs-human", reason: "CI の失敗を直せなかった" } : { kind: "done" };
    }
  }
  return {
    kind: "needs-human",
    reason: `修正ループが上限（${cfg.maxRounds} 回）に達した。最後の修正は未レビュー`,
  };
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
