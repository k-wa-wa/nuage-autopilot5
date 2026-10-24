import { type AgentSpec, formatAgentSpec } from "./agents.ts";
import { type CiVerdict, judgeCi } from "./ci.ts";
import type { GitHub } from "./github.ts";
import * as prompts from "./prompts.ts";

/**
 * 任された仕事を最後まで進める流れ。
 *
 *   実装 → PR → [CI 待ち → レビュー → 修正] を上限回数まで → 要約
 *
 * 順序と待ちはここが持ち、判断は LLM に任せる。
 * 成否はエージェントの自己申告ではなく、commit・PR・push が実際にできたかで判定する。
 */

/** CI の状態を読み直す間隔。 */
export const CI_POLL_MS = 30_000;

export interface Config {
  impl: AgentSpec;
  reviewers: AgentSpec[];
  maxRounds: number;
  baseSha: string;
}

export interface Deps {
  /** エージェントを 1 ターン実行する。outputName を渡すとその名前で標準出力を保存する。 */
  runAgent(spec: AgentSpec, prompt: string, outputName?: string): Promise<boolean>;
  head(): Promise<string>;
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
export function reviewFileName(spec: AgentSpec, round: number): string {
  const slug = formatAgentSpec(spec).replace(/[^A-Za-z0-9._-]+/g, "-");
  return `review-${round}-${slug}.md`;
}

export async function runPipeline(cfg: Config, d: Deps): Promise<Outcome> {
  const mode: prompts.ShipMode = d.github ? "pr" : "local";

  d.state.stage(`implementing (${formatAgentSpec(cfg.impl)})`);
  if (!(await d.runAgent(cfg.impl, prompts.implement(mode)))) {
    return { kind: "failed", reason: "実装担当が異常終了した" };
  }
  if ((await d.head()) === cfg.baseSha) {
    return { kind: "failed", reason: "何も commit されなかった" };
  }

  let pr: number | null = null;
  if (d.github) {
    pr = await d.github.prNumber();
    if (pr === null) return { kind: "failed", reason: "PR が作られなかった" };
    d.state.log(`PR #${pr}`);
  }

  const outcome = await rounds(cfg, d, mode, pr);
  if (outcome.kind === "failed") return outcome;

  d.state.stage("summarizing");
  if (!(await d.runAgent(cfg.impl, prompts.summarize(cfg.baseSha, pr)))) {
    d.state.log("要約担当が異常終了した");
  }
  return outcome;
}

async function rounds(
  cfg: Config,
  d: Deps,
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

    d.state.stage(`reviewing (round ${round}: ${cfg.reviewers.map(formatAgentSpec).join(", ")})`);
    const results = await Promise.all(
      cfg.reviewers.map(async (rv) => {
        const name = reviewFileName(rv, round);
        const ok = await d.runAgent(rv, prompts.review(cfg.baseSha), name);
        if (!ok) d.state.log(`レビュー失敗: ${formatAgentSpec(rv)}`);
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
    if (!(await d.runAgent(cfg.impl, prompts.fix({ mode, reviews, ciLog, inbox })))) {
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
