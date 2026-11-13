import { type FailureKind, formatInvocation, type Invocation } from "./agents.ts";
import { type CiVerdict, judgeCi } from "./ci.ts";
import type { GateFile, GitHub } from "./github.ts";
import type { Assignee, Assignment } from "./models.ts";
import * as prompts from "./prompts.ts";

/**
 * 任された仕事を最後まで進める流れ。
 *
 *   実装 → PR → [CI 待ち ‖ レビュー → 修正] を上限回数まで → ゲート → 要約
 *
 * 修正ループは、指摘の連鎖で上限まで回らないように絞る。
 * - 1 周目は must と should を直し、2 周目以降は must だけを直す。nit と見送った指摘は要約で人間に渡す
 * - レビューに must が無ければ、直した後に再レビューしない（CI だけ確かめる）
 * - CI 待ちとレビューは同時に進める。レビューは CI の結果を使わない
 * - 修正担当は実装担当の会話の続きで動く。コードを一から読み直さずに済む
 * - 修正ループが done で終わろうとするときにゲートを走らせる。不合格なら修正ループへ戻る
 *
 * 実装・修正・ゲートの担当の後には毎回、作業ツリーに未 commit のファイルが残っていないかを確かめる。
 * 残っていれば、未 commit の変更込みで検証して done にしないよう needs-human にする。
 *
 * --from review では実装を飛ばし、今のブランチの PR（--local ならローカルの commit）のレビューから始める。
 * --from gate では実装とレビューを飛ばし、CI を待ってからゲートだけを走らせる。
 *
 * 順序と待ちはここが持ち、判断は LLM に任せる。
 * 成否はエージェントの自己申告ではなく、commit・PR・push が実際にできたかで判定する。
 *
 * 担当はモデルの並びを持ち、失敗したら次のモデルで試し直す（利用上限・認証切れ・会話切れ）。
 * ただしコードを書き換える作業は、途中まで書き換えて落ちたなら試し直さない。別のモデルが続きを書くと混ざる。
 */

/** CI の状態を読み直す間隔。 */
export const CI_POLL_MS = 30_000;

/** どこから始めるか。review はレビューから、gate はゲートから。 */
export const START_POINTS = ["implement", "review", "gate"] as const;
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
  failure?: FailureKind;
  /** 成功した実行。修正担当を固定するため Runner が付ける。 */
  invocation?: Invocation;
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
  /** 作業ツリーに残っている未 commit のファイル（git status --porcelain の各行）。綺麗なら空。 */
  uncommitted(): Promise<string[]>;
  /** 基点の木にあるゲートファイルを見つける。 */
  findGates(baseSha: string): Promise<GateFile[]>;
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
    write(name: string, text: string): void;
    append(name: string, text: string): void;
    takeInbox(round: number): string | null;
  };
}

export type Outcome =
  | { kind: "done" }
  | { kind: "needs-human"; reason: string }
  | { kind: "failed"; reason: string };

export interface ReviewOutcome {
  files: string[];
  missing: string[];
}

export function formatOutcome(o: Outcome): string {
  return o.kind === "done" ? "done" : `${o.kind}: ${o.reason}`;
}

/** レビュー結果のファイル名。エージェント名ではなく観点で付ける。 */
export function reviewFileName(perspective: prompts.ReviewPerspectiveSlug, round: number): string {
  return `review-${round}-${perspective}.md`;
}

/** 担当を、モデルの並びの前から順に試す。 */
class Runner {
  /** 利用不能になったモデル。この実行の間は再利用しない。 */
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
    const order = who.chain.filter((inv) => !this.failed.has(formatInvocation(inv)));
    for (const [i, inv] of order.entries()) {
      const before = opts.writes ? await this.d.fingerprint() : "";
      const r = await this.d.runAgent(inv, prompt, { output: opts.output, session: opts.session });
      if (r.ok) return { ...r, invocation: inv };
      if (r.failure !== "unavailable") return failed;
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
  private invocation: Invocation | null = null;

  constructor(
    private readonly d: Deps,
    private readonly runner: Runner,
  ) {}

  async run(who: Assignee, prompt: string): Promise<boolean> {
    const plan: SessionPlan = this.session
      ? { kind: "resume", id: this.session }
      : { kind: "start" };
    // 一度成功した実装・修正担当は固定する。別 CLI に会話 ID を渡さない。
    const r = this.invocation
      ? await this.d.runAgent(this.invocation, prompt, { session: plan })
      : await this.runner.run(who, prompt, { writes: true, session: plan });
    if (r.ok && r.invocation) this.invocation = r.invocation;
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
  /** 実装担当が未 commit のファイルを残したら、レビュー・ゲートへ進まず要約して人間に返す。 */
  const leftover = cfg.from === "implement" ? await leftoverReason(d, "実装担当の実行後") : null;

  let pr: number | null = null;
  if (d.github) {
    pr = await d.github.prNumber();
    if (pr === null && leftover === null) {
      return {
        kind: "failed",
        reason: cfg.from === "implement" ? "PR が作られなかった" : "PR が無い",
      };
    }
    if (pr !== null) d.state.log(`PR #${pr}`);
  }

  const missingPerspectives = new Set<string>();
  const outcome: Outcome = leftover
    ? { kind: "needs-human", reason: leftover }
    : await rounds(cfg, d, runner, writer, mode, pr, missingPerspectives);
  if (outcome.kind === "failed") return outcome;

  d.state.stage("summarizing");
  // 要約はコードを書き換えない（result.md と PR 本文だけ）ので、何度試し直してもよい。
  if (
    !(
      await runner.run(
        cfg.summarize,
        prompts.summarize(cfg.baseSha, pr, formatOutcome(outcome), Array.from(missingPerspectives)),
        { writes: false },
      )
    ).ok
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
  missingPerspectives: Set<string>,
): Promise<Outcome> {
  /** 今の HEAD にレビューが要るか。must の無いレビューの後の修正は、CI だけ確かめる。 */
  let needsReview = cfg.from !== "gate";
  /** 前回レビューした HEAD。2 周目以降のレビューは、ここからの修正を中心に見る。 */
  let reviewedAt: string | null = null;
  /** 直前の周で直せなかったゲート不合格。次の周の修正担当へ渡す。 */
  let pendingGateFailures: string[] | null = null;
  /** 全ゲートが合格（または対象外・ゲートなし）した HEAD。同じ HEAD でゲートを走らせ直さない。 */
  let gatesPassedAt: string | null = null;
  /** 直前の修正がゲートの不合格を直したものか。上限に達したときの理由に使う。 */
  let lastFixForGate = false;

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
    const ciPromise: Promise<CiVerdict | null> = github
      ? waitCi(d, github.gh, github.pr)
      : Promise.resolve(null);
    const reviewPromise: Promise<ReviewOutcome | null> = needsReview
      ? review(cfg, d, runner, round, reviewedAt)
      : Promise.resolve(null);
    const [ci, reviewRes] = await Promise.all([ciPromise, reviewPromise]);

    if (reviewRes) {
      for (const m of reviewRes.missing) missingPerspectives.add(`${m} (round ${round})`);
    }
    const reviews = reviewRes ? reviewRes.files : null;

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
    let inbox = inboxName ? d.state.rel(inboxName) : null;

    let gateLogs: string[] = pendingGateFailures ?? [];
    pendingGateFailures = null;

    if (!must && ciLog === null && inbox === null && gateLogs.length === 0) {
      if (reviews === null) {
        d.state.log("レビューは不要なので、CI の確認後にゲートへ進む");
      } else if (round > 1) {
        d.state.log("レビューに must が無いので、何も直さずに終える");
      }
      if (reviews === null || round > 1) {
        const gateOutcome = await runGates(cfg, d, runner, round, pr);
        if (gateOutcome.kind === "needs-human") {
          return { kind: "needs-human", reason: gateOutcome.reason };
        }
        // ゲートの待ち時間に届いた指示も、この周の修正へ渡す。
        const duringGate = d.state.takeInbox(round);
        inbox = duringGate ? d.state.rel(duringGate) : null;
        if (gateOutcome.kind === "fail") gateLogs = gateOutcome.failures;
        else {
          gatesPassedAt = head;
          if (inbox === null) return { kind: "done" };
        }
      }
    }

    d.state.stage(`fixing (round ${round})`);
    const prompt = prompts.fix({
      mode,
      scope: round === 1 ? "must-should" : "must",
      reviews: (reviews ?? []).map((name) => d.state.rel(name)),
      ciLog,
      inbox,
      gateLogs,
    });
    if (!(await writer.run(cfg.fix, prompt))) {
      return { kind: "failed", reason: "修正担当が異常終了した" };
    }

    // HEAD が変わったかに関係なく毎回確かめる。一部だけ commit した残りをゲートで確かめて done にしない。
    const leftover = await leftoverReason(d, "修正担当の実行後");
    const needsHuman = d.state.read("needs-human.md")?.trim();
    if (needsHuman || leftover) {
      const asked = needsHuman
        ? (needsHuman
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? "修正担当が人間に判断を求めた")
        : null;
      return { kind: "needs-human", reason: [asked, leftover].filter(Boolean).join("。") };
    }

    if ((await d.head()) === head) {
      if (ciLog) return { kind: "needs-human", reason: "CI の失敗を直せなかった" };
      if (gateLogs.length > 0)
        return { kind: "needs-human", reason: "ゲートの不合格を直せなかった" };
      if (gatesPassedAt === head) {
        d.state.log("この HEAD はゲートに合格済みなので、ゲートを走らせ直さない");
      } else {
        const gateOutcome = await runGates(cfg, d, runner, round, pr);
        if (gateOutcome.kind === "needs-human") {
          return { kind: "needs-human", reason: gateOutcome.reason };
        }
        if (gateOutcome.kind === "fail") pendingGateFailures = gateOutcome.failures;
        else gatesPassedAt = head;
      }
      if (pendingGateFailures === null && !d.state.read("inbox.md")) return { kind: "done" };
      // この周の修正は済んでいる。新しい指示は退避せず次の周に渡す。
      needsReview = false;
      continue;
    }

    // ゲートだけの修正は再レビューしない。追加指示による変更はレビューする。
    needsReview = inbox !== null || (must && gateLogs.length === 0);
    lastFixForGate = gateLogs.length > 0;
    if (!needsReview) {
      d.state.log(
        gateLogs.length > 0
          ? "ゲートの不合格を直したので、次は CI と全ゲートを確かめる"
          : "must の無い修正なので、次は CI だけ確かめる",
      );
    }
  }
  const remaining = [
    pendingGateFailures && "ゲートの不合格が未修正で残っている",
    d.state.read("inbox.md") && "人間の追加指示が未処理で残っている",
  ].filter(Boolean);
  if (remaining.length === 0) {
    remaining.push(
      needsReview
        ? "最後の修正は未レビュー"
        : lastFixForGate
          ? "最後の修正の CI と全ゲートを確かめていない"
          : "最後の修正の CI を確かめていない",
    );
  }
  return {
    kind: "needs-human",
    reason: `修正ループが上限（${cfg.maxRounds} 回）に達した。${remaining.join("。")}`,
  };
}

/** 観点ごとのレビュー担当を全員並べて走らせ、書けたレビューのファイル名を返す。 */
async function review(
  cfg: Config,
  d: Deps,
  runner: Runner,
  round: number,
  since: string | null,
): Promise<ReviewOutcome> {
  const results = await Promise.all(
    cfg.reviewers.map(async (rv) => {
      const name = reviewFileName(rv.perspective, round);
      // レビュー担当はファイルを書き換えないので、失敗したら常に次のモデルで試し直す。
      const r = await runner.run(
        rv,
        prompts.review(rv.perspective, { baseSha: cfg.baseSha, since }),
        {
          writes: false,
          output: name,
        },
      );
      if (r.ok && r.invocation) {
        const invStr = formatInvocation(r.invocation);
        d.state.append(name, `\n担当: ${invStr}\n`);
        d.state.log(`レビュー (${rv.perspective}): ${invStr}`);
        return { ok: true, name, perspective: rv.perspective };
      }
      d.state.log(`レビュー失敗 (${rv.perspective}): ${rv.name} の全候補が失敗した`);
      return { ok: false, name, perspective: rv.perspective };
    }),
  );
  return {
    files: results.filter((r) => r.ok).map((r) => r.name),
    missing: results.filter((r) => !r.ok).map((r) => r.perspective),
  };
}

/** 理由に並べる未 commit のファイルの数。多ければ先頭だけにする。 */
const LEFTOVER_SHOWN = 5;

/** 作業ツリーに未 commit のファイルが残っていれば、needs-human の理由を返す。綺麗なら null。 */
async function leftoverReason(d: Deps, when: string): Promise<string | null> {
  const files = (await d.uncommitted()).map((l) => l.trim());
  if (files.length === 0) return null;
  const shown = files.slice(0, LEFTOVER_SHOWN).join(", ");
  const more = files.length > LEFTOVER_SHOWN ? ` ほか ${files.length - LEFTOVER_SHOWN} 件` : "";
  const reason = `${when}、作業ツリーに未 commit のファイルが残っている: ${shown}${more}`;
  d.state.log(reason);
  return reason;
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

type GateOutcome =
  | { kind: "pass" }
  | { kind: "none" }
  | { kind: "fail"; failures: string[] }
  | { kind: "needs-human"; reason: string };

/**
 * リポジトリのゲート（.agents/autopilot-gate*.md）を並列に実行する。
 * 基点の木から読んだ手順書を実行し、合否を判定する。
 */
async function runGates(
  cfg: Config,
  d: Deps,
  runner: Runner,
  round: number,
  pr: number | null,
): Promise<GateOutcome> {
  let gateFiles: GateFile[];
  try {
    gateFiles = await d.findGates(cfg.baseSha);
  } catch (e) {
    const reason = `ゲートの手順書を読めない: ${e instanceof Error ? e.message : String(e)}`;
    d.state.log(reason);
    return { kind: "needs-human", reason };
  }
  if (gateFiles.length === 0) {
    d.state.log("ゲートなし");
    return { kind: "none" };
  }

  d.state.stage(`gating (round ${round}: ${gateFiles.map((g) => g.name).join(", ")})`);

  const results = await Promise.all(
    gateFiles.map(async (g) => {
      const srcFile = `gate-src-${g.name}.md`;
      d.state.write(srcFile, g.content);

      const outName = `gate-${round}-${g.name}.md`;
      const prompt = prompts.gate({
        name: g.name,
        sourcePath: d.state.rel(srcFile),
        baseSha: cfg.baseSha,
        pr,
      });

      const r = await runner.run(cfg.gate, prompt, { writes: false, output: outName });
      if (r.ok && r.invocation) {
        const invStr = formatInvocation(r.invocation);
        d.state.append(outName, `\n担当: ${invStr}\n`);
        const content = d.state.read(outName) ?? "";
        const verdict = prompts.parseGateVerdict(content);
        d.state.log(`ゲート (${g.name}): ${verdict} 担当: ${invStr}`);
        return { name: g.name, verdict, file: outName };
      }
      d.state.log(`ゲート失敗 (${g.name}): ${cfg.gate.name} の全候補が失敗した`);
      return { name: g.name, verdict: "failed_run" as const, file: outName };
    }),
  );

  // ゲートはファイルを書き換えない。残ったファイルを次の修正担当のものと取り違えないよう、ここで止める。
  const leftover = await leftoverReason(d, "ゲートの実行後");
  if (leftover) return { kind: "needs-human", reason: leftover };

  const failedRun = results.find((r) => r.verdict === "failed_run");
  if (failedRun) {
    return { kind: "needs-human", reason: `ゲート担当が全員失敗した: ${failedRun.name}` };
  }

  const inconclusive = results.find((r) => r.verdict === "inconclusive");
  if (inconclusive) {
    return { kind: "needs-human", reason: `ゲートが判定不能: ${inconclusive.name}` };
  }

  const unknown = results.find((r) => r.verdict === "unknown");
  if (unknown) {
    return { kind: "needs-human", reason: `ゲートの判定を読めない: ${unknown.name}` };
  }

  const fails = results.filter((r) => r.verdict === "fail");
  if (fails.length > 0) {
    return {
      kind: "fail",
      failures: fails.map((f) => d.state.rel(f.file)),
    };
  }

  return { kind: "pass" };
}
