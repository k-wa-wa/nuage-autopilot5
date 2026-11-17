import { describe, expect, test } from "bun:test";
import { CI_LIMITS } from "./ci.ts";
import { assignRoles } from "./models.ts";
import {
  reviewFileName,
  reviewFileNames,
  runPipeline,
  safeAssigneeSlug,
  specReviewFileName,
  specReviewFileNames,
} from "./pipeline.ts";
import { GATE_VERDICT, VERDICT } from "./prompts.ts";
import { assignee, checks, pipelineConfig, pipelineHarness } from "./testing/helpers.ts";

const cfg = pipelineConfig(assignee("claude"), [assignee("agy"), assignee("codex")]);

describe("担当 CLI の切り替えと維持", () => {
  const defaults = { ...cfg, ...assignRoles({ level: "high" }, {}) };

  test("利用不能の実装担当を順に試し、成功した担当・会話を修正でも維持する", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      failAgent: (inv, kind) => kind === "implement" && inv.agent === "agy",
    });
    expect(await runPipeline(defaults, h.deps)).toEqual({ kind: "done" });
    expect(
      h.calls.filter((c) => c.kind === "implement").map((c) => [c.inv.agent, c.session]),
    ).toEqual([
      ["agy", { kind: "start" }],
      ["codex", { kind: "start" }],
    ]);
    const fix = h.calls.find((c) => c.kind === "fix")!;
    expect(fix.inv.agent).toBe("codex");
    expect(fix.session).toEqual({ kind: "resume", id: "conv1" });
  });

  test("通常の異常終了や通信障害では次の CLI を試さない", async () => {
    const h = pipelineHarness({
      commits: [],
      failure: "error",
      failAgent: (_, k) => k === "implement",
    });
    expect((await runPipeline(defaults, h.deps)).kind).toBe("failed");
    expect(h.calls.map((c) => c.inv.agent)).toEqual(["agy"]);
  });

  test("変更途中の利用不能では次の CLI に切り替えない", async () => {
    const h = pipelineHarness({
      commits: [],
      failAgent: (_, k) => k === "implement",
      dirtyOnFail: () => true,
    });
    expect((await runPipeline(defaults, h.deps)).kind).toBe("failed");
    expect(h.calls.map((c) => c.inv.agent)).toEqual(["agy"]);
  });

  test("レビューは claude → codex → agy。実装と同じ CLI の別会話も許容する", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      failAgent: (inv, kind) => kind === "review" && inv.agent !== "agy",
    });
    expect((await runPipeline(defaults, h.deps)).kind).toBe("done");
    const reviews = h.calls.filter((c) => c.kind === "review");
    expect(reviews.map((c) => c.inv.agent)).toEqual(["claude", "codex", "agy"]);
    expect(reviews.every((c) => c.session === undefined)).toBe(true);
  });

  test("修正時に利用上限に達したら、変更がなくても別担当へ切り替えない", async () => {
    const h = pipelineHarness({ commits: [true], failAgent: (_, kind) => kind === "fix" });
    expect(await runPipeline(defaults, h.deps)).toEqual({
      kind: "failed",
      reason: "修正担当が異常終了した",
    });
    expect(h.calls.filter((c) => c.kind === "fix").map((c) => c.inv.agent)).toEqual(["agy"]);
  });
});

describe("runPipeline: 基本の流れ", () => {
  test("実装 → レビュー → 直すもの無しで完了し、最後に要約する", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => `${c.inv.agent}:${c.kind}`)).toEqual([
      "claude:implement",
      "agy:review",
      "codex:review",
      "claude:fix",
      "claude:summarize",
    ]);
  });

  test("レビューは担当ごとに別ファイルへ保存し、修正のプロンプトに全部渡す", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    await runPipeline(cfg, h.deps);
    expect(h.calls.filter((c) => c.kind === "review").map((c) => c.output)).toEqual([
      "review-1-agy.md",
      "review-1-codex.md",
    ]);
    const fix = h.calls.find((c) => c.kind === "fix")!;
    expect(fix.prompt).toContain(".autopilot/review-1-agy.md");
    expect(fix.prompt).toContain(".autopilot/review-1-codex.md");
  });

  test("レビューが成功したら、ファイルの末尾に担当行を追記する", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    await runPipeline(cfg, h.deps);
    expect(h.deps.state.read("review-1-agy.md")).toContain("\n担当: agy\n");
    expect(h.deps.state.read("review-1-codex.md")).toContain("\n担当: codex\n");
  });

  test("レビューが成功したら、run.log に担当を残す", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    await runPipeline(cfg, h.deps);
    expect(h.logs).toContain("レビュー: agy");
    expect(h.logs).toContain("レビュー: codex");
  });

  test("人間の追加指示は修正のプロンプトに渡す", async () => {
    const h = pipelineHarness({ commits: [true, false], inbox: true });
    await runPipeline(cfg, h.deps);
    expect(h.calls.find((c) => c.kind === "fix")?.prompt).toContain(".autopilot/inbox-1.md");
  });

  test("指摘を直したら次のラウンドでもう一度レビューする", async () => {
    const h = pipelineHarness({ commits: [true, true, false] });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.stages.filter((s) => s.startsWith("reviewing"))).toHaveLength(2);
  });

  test("修正が続いて上限に達したら、未レビューの修正があるので人間に戻す", async () => {
    const h = pipelineHarness({ commits: [true, true, true, true] });
    const o = await runPipeline(cfg, h.deps);
    expect(o.kind).toBe("needs-human");
    expect(h.stages.filter((s) => s.startsWith("reviewing"))).toHaveLength(3);
    expect(h.calls.at(-1)?.kind).toBe("summarize");
  });
});

describe("runPipeline: 修正ループを指摘の連鎖で回し続けない", () => {
  const one = pipelineConfig(assignee("claude"), [assignee("agy")]);
  const none = () => `${VERDICT.none}\n- should: 直すとよい\n- nit: 体裁`;
  const must = () => `${VERDICT.must}\n- must: 壊れている`;
  const reviewsOf = (h: ReturnType<typeof pipelineHarness>) =>
    h.calls.filter((c) => c.kind === "review");
  const fixesOf = (h: ReturnType<typeof pipelineHarness>) =>
    h.calls.filter((c) => c.kind === "fix");

  test("1 周目に must が無ければ、should まで直して再レビューせずに終える", async () => {
    const h = pipelineHarness({ commits: [true, true], review: none });
    expect(await runPipeline(one, h.deps)).toEqual({ kind: "done" });
    expect(reviewsOf(h)).toHaveLength(1);
    expect(fixesOf(h)[0]?.prompt).toContain("must と should を直す");
    expect(h.calls.at(-1)?.kind).toBe("summarize");
    expect(h.stages).not.toContain("");
  });

  test("must の無い修正は、CI だけ確かめて終える", async () => {
    const h = pipelineHarness({ commits: [true, true], review: none, github: { pr: 7 } });
    expect(await runPipeline(one, h.deps)).toEqual({ kind: "done" });
    expect(reviewsOf(h)).toHaveLength(1);
    expect(h.stages).toContain("waiting CI (round 2)");
  });

  test("must の無い修正で CI が落ちたら、レビューせずに CI だけ直させる", async () => {
    const h = pipelineHarness({
      commits: [true, true, true],
      review: none,
      github: { pr: 7, snapshots: [checks("pass"), checks("fail"), checks("pass")] },
    });
    expect(await runPipeline(one, h.deps)).toEqual({ kind: "done" });
    expect(reviewsOf(h)).toHaveLength(1);
    const second = fixesOf(h)[1]!;
    expect(second.prompt).toContain(".autopilot/ci-fail-2.log");
    expect(second.prompt).not.toContain("レビュー結果");
  });

  test("2 周目以降は must だけを直させる", async () => {
    const h = pipelineHarness({ commits: [true, true, false], review: must });
    await runPipeline(one, h.deps);
    const [first, second] = fixesOf(h);
    expect(first?.prompt).toContain("must と should を直す");
    expect(second?.prompt).toContain("must だけを直す");
  });

  test("2 周目のレビューに must が無ければ、修正担当を呼ばずに終える", async () => {
    const h = pipelineHarness({
      commits: [true, true],
      review: (round) => (round === 1 ? must() : none()),
    });
    expect(await runPipeline(one, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => c.kind)).toEqual([
      "implement",
      "review",
      "fix",
      "review",
      "summarize",
    ]);
  });

  test("2 周目のレビューは、前回レビューした HEAD からの修正を中心に見させる", async () => {
    const h = pipelineHarness({ commits: [true, true, false], review: must });
    await runPipeline(one, h.deps);
    const first = reviewsOf(h)[0]!;
    const second = reviewsOf(h)[1]!;
    expect(first?.prompt).not.toContain("前回のレビューの後の修正");
    expect(second?.prompt).toContain("git diff sha1..HEAD");
    expect(second?.prompt).toContain("git diff sha0...HEAD");
  });

  test("人間の追加指示を受けた修正は、must が無くても再レビューする", async () => {
    const h = pipelineHarness({ commits: [true, true, false], review: none, inbox: true });
    expect(await runPipeline(one, h.deps)).toEqual({ kind: "done" });
    expect(reviewsOf(h)).toHaveLength(2);
  });

  test("上限で終わったとき、最後の修正が must でなければ CI を確かめていないと伝える", async () => {
    const h = pipelineHarness({ commits: [true, true], review: none, github: { pr: 7 } });
    expect(await runPipeline({ ...one, maxRounds: 1 }, h.deps)).toEqual({
      kind: "needs-human",
      reason: "修正ループが上限（1 回）に達した。最後の修正の CI を確かめていない",
    });
  });

  test("CI 待ちとレビューを同時に進める（CI が終わるのを待たずにレビューを始める）", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      github: { pr: 7, snapshots: [checks("pending"), checks("pending"), checks("pass")] },
    });
    expect(await runPipeline(one, h.deps)).toEqual({ kind: "done" });
    expect(reviewsOf(h)[0]?.at).toBe(0);
    expect(fixesOf(h)[0]?.at).toBeGreaterThan(0);
  });
});

describe("runPipeline: 修正担当は実装担当の会話を引き継ぐ", () => {
  const one = pipelineConfig(assignee("claude"), [assignee("agy")]);

  test("実装で会話を始め、修正はその続きで行う。レビューと要約は会話を持たない", async () => {
    const h = pipelineHarness({ commits: [true, true, false] });
    await runPipeline(one, h.deps);
    expect(h.calls.map((c) => `${c.kind}:${JSON.stringify(c.session ?? null)}`)).toEqual([
      'implement:{"kind":"start"}',
      "review:null",
      'fix:{"kind":"resume","id":"conv1"}',
      "review:null",
      'fix:{"kind":"resume","id":"conv1"}',
      "summarize:null",
    ]);
  });

  test("会話 ID を読めなければ、修正は新しい会話で始め、そのことをログに残す", async () => {
    const h = pipelineHarness({ commits: [true, false], noSession: true });
    await runPipeline(one, h.deps);
    expect(h.calls.find((c) => c.kind === "fix")?.session).toEqual({ kind: "start" });
    expect(h.logs).toContain("会話 ID を読めなかった。次の修正は新しい会話で始める");
  });

  test("--from review では、最初の修正で会話を始め、次の修正はその続きで行う", async () => {
    const h = pipelineHarness({ commits: [true, false], startHead: 2 });
    await runPipeline({ ...one, from: "review" }, h.deps);
    expect(h.calls.filter((c) => c.kind === "fix").map((c) => c.session)).toEqual([
      { kind: "start" },
      { kind: "resume", id: "conv1" },
    ]);
  });

  test("実装の試し直しで別のモデルに切り替えても、修正は成功した会話の続きで行う", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      failAgent: (inv, k) => k === "implement" && inv.model === "c1",
    });
    await runPipeline(pipelineConfig(assignee("claude", "c1", "c2"), [assignee("agy")]), h.deps);
    expect(h.calls.find((c) => c.kind === "fix")?.session).toEqual({ kind: "resume", id: "conv1" });
  });
});

describe("runPipeline: 成否は成果物で判定する", () => {
  test("何も commit しなければ失敗にする（exit 0 を信用しない）", async () => {
    const h = pipelineHarness({ commits: [false] });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "failed",
      reason: "何も commit されなかった",
    });
  });

  test("既存の PR の続きでも、実装で commit が増えなければ失敗にする", async () => {
    const h = pipelineHarness({ commits: [false], startHead: 2, github: { pr: 7 } });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "failed",
      reason: "何も commit されなかった",
    });
  });

  test("既存の PR の続きで commit が増えれば先へ進む", async () => {
    const h = pipelineHarness({ commits: [true, false], startHead: 2, github: { pr: 7 } });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
  });

  test("PR モードでも commit が無ければ失敗にする", async () => {
    const h = pipelineHarness({ commits: [false], github: { pr: 7 } });
    expect((await runPipeline(cfg, h.deps)).kind).toBe("failed");
  });

  test("PR が作られなければ失敗にする", async () => {
    const h = pipelineHarness({ commits: [true], github: { pr: null } });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "failed",
      reason: "PR が作られなかった",
    });
  });

  test("push されないまま猶予を過ぎたら失敗にし、要約はしない", async () => {
    const h = pipelineHarness({
      commits: [true],
      github: { pr: 7, snapshots: [() => ({ head: "old", checks: ["pass"] })] },
    });
    const o = await runPipeline(cfg, h.deps);
    expect(o.kind).toBe("failed");
    expect(h.elapsed()).toBeGreaterThan(CI_LIMITS.pushGraceMs);
    expect(h.calls.some((c) => c.kind === "summarize")).toBe(false);
  });

  test("実装担当が異常終了したら失敗にする", async () => {
    const h = pipelineHarness({ commits: [true], failAgent: (_, k) => k === "implement" });
    expect((await runPipeline(cfg, h.deps)).kind).toBe("failed");
  });

  test("修正担当が異常終了したら失敗にする", async () => {
    const h = pipelineHarness({ commits: [true], failAgent: (_, k) => k === "fix" });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "failed",
      reason: "修正担当が異常終了した",
    });
  });
});

describe("runPipeline: CI", () => {
  test("CI が通るのを待ってからレビューする", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      github: { pr: 7, snapshots: [checks("pending"), checks("pending"), checks("pass")] },
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.elapsed()).toBeGreaterThan(0);
  });

  test("push の反映を待つ（古いコミットの緑を読まない）", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      github: {
        pr: 7,
        snapshots: [() => ({ head: "old", checks: ["pass"] }), checks("fail")],
      },
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "needs-human",
      reason: "CI の失敗を直せなかった",
    });
  });

  test("CI の失敗ログは、そのコミットのものを保存して修正に渡す", async () => {
    const h = pipelineHarness({
      commits: [true, true, false],
      github: { pr: 7, snapshots: [checks("fail"), checks("pass")] },
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.savedLogs).toEqual(["sha1"]);
    expect(h.calls.find((c) => c.kind === "fix")?.prompt).toContain(".autopilot/ci-fail-1.log");
    expect(h.stages.filter((s) => s.includes("waiting CI"))).toHaveLength(2);
  });

  test("CI の失敗を直せなければ人間に戻す", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      github: { pr: 7, snapshots: [checks("fail")] },
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "needs-human",
      reason: "CI の失敗を直せなかった",
    });
  });

  test("CI の無いリポジトリでは、登録の猶予を待ってから先へ進む", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      github: { pr: 7, snapshots: [checks()] },
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.elapsed()).toBeGreaterThan(CI_LIMITS.noChecksGraceMs);
  });

  test("CI が終わらなければ人間に戻す", async () => {
    const h = pipelineHarness({
      commits: [true],
      github: { pr: 7, snapshots: [checks("pending")] },
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "needs-human",
      reason: "CI が終わらない",
    });
  });

  test("GitHub を一時的に読めなくても、待ち直して続ける", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      github: { pr: 7, snapshots: [() => null, checks("pass")] },
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.logs).toContain("GitHub を読めない");
  });
});

describe("runPipeline: レビュー担当の失敗", () => {
  test("一部が落ちても止めず、落ちた担当のレビューは修正に渡さない", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      failAgent: (s, k) => s.agent === "agy" && k === "review",
    });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    const fix = h.calls.find((c) => c.kind === "fix")!;
    expect(fix.prompt).not.toContain("review-1-agy.md");
    expect(fix.prompt).toContain("review-1-codex.md");
  });

  test("全員が落ちたら、レビュー無しで完了にせず人間に戻す", async () => {
    const h = pipelineHarness({ commits: [true], failAgent: (_, k) => k === "review" });
    expect(await runPipeline(cfg, h.deps)).toEqual({
      kind: "needs-human",
      reason: "レビュー担当が全員失敗した",
    });
    expect(h.calls.some((c) => c.kind === "fix")).toBe(false);
  });
});

describe("runPipeline: モデルの切り替え", () => {
  const claude = assignee("claude", "c1", "c2");
  const agy = assignee("agy", "a1", "a2");
  const models = (h: ReturnType<typeof pipelineHarness>, kind: string) =>
    h.calls.filter((c) => c.kind === kind).map((c) => c.inv.model);

  test("レビュー担当が失敗したら、次のモデルで試し直す", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      failAgent: (inv) => inv.model === "a1",
    });
    expect(await runPipeline(pipelineConfig(claude, [agy]), h.deps)).toEqual({ kind: "done" });
    expect(models(h, "review")).toEqual(["a1", "a2"]);
    expect(h.logs).toContain("agy:a1 が失敗した。agy:a2 で試し直す");
  });

  test("一度失敗したモデルは、次のラウンドでは後回しにする", async () => {
    const h = pipelineHarness({
      commits: [true, true, false],
      failAgent: (inv) => inv.model === "a1",
    });
    await runPipeline(pipelineConfig(claude, [agy]), h.deps);
    expect(models(h, "review")).toEqual(["a1", "a2", "a2"]);
  });

  test("並びが全部失敗したら、その担当は失敗にする（下の段階には落とさない）", async () => {
    const h = pipelineHarness({ commits: [true], failAgent: (_, k) => k === "review" });
    expect((await runPipeline(pipelineConfig(claude, [agy]), h.deps)).kind).toBe("needs-human");
    expect(models(h, "review")).toEqual(["a1", "a2"]);
  });

  test("実装担当が何も変えずに失敗したら、次のモデルで実装する", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      failAgent: (inv, k) => k === "implement" && inv.model === "c1",
    });
    expect(await runPipeline(pipelineConfig(claude, [agy]), h.deps)).toEqual({ kind: "done" });
    expect(models(h, "implement")).toEqual(["c1", "c2"]);
  });

  test("実装担当が途中まで書き換えて失敗したら、続きが混ざるので切り替えない", async () => {
    const h = pipelineHarness({
      commits: [true],
      failAgent: (inv, k) => k === "implement" && inv.model === "c1",
      dirtyOnFail: () => true,
    });
    expect(await runPipeline(pipelineConfig(claude, [agy]), h.deps)).toEqual({
      kind: "failed",
      reason: "実装担当が異常終了した",
    });
    expect(models(h, "implement")).toEqual(["c1"]);
  });

  test("修正担当も、途中まで書き換えて失敗したら切り替えない", async () => {
    const h = pipelineHarness({
      commits: [true],
      failAgent: (inv, k) => k === "fix" && inv.model === "c1",
      dirtyOnFail: () => true,
    });
    expect((await runPipeline(pipelineConfig(claude, [agy]), h.deps)).kind).toBe("failed");
    expect(models(h, "fix")).toEqual(["c1"]);
  });

  test("作業ごとに別の並びを使う（実装・修正・要約・レビュー）", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    await runPipeline(
      {
        ...pipelineConfig(assignee("claude", "hi"), [assignee("agy", "rv")]),
        summarize: assignee("claude", "lo"),
      },
      h.deps,
    );
    expect(h.calls.map((c) => `${c.kind}=${c.inv.model}`)).toEqual([
      "implement=hi",
      "review=rv",
      "fix=hi",
      "summarize=lo",
    ]);
  });
});

describe("runPipeline: --from review", () => {
  const fromReview = pipelineConfig(assignee("claude"), [assignee("agy")], { from: "review" });

  test("実装を呼ばず、今のブランチの PR の CI を待ってからレビューする", async () => {
    const h = pipelineHarness({ commits: [false], startHead: 2, github: { pr: 56 } });
    expect(await runPipeline(fromReview, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => c.kind)).toEqual(["review", "fix", "summarize"]);
    expect(h.stages.some((s) => s.startsWith("implementing"))).toBe(false);
    expect(h.stages[0]).toBe("reviewing (round 1: agy) + waiting CI");
    expect(h.logs).toContain("PR #56");
  });

  test("PR が無ければ、何も呼ばずに失敗にする", async () => {
    const h = pipelineHarness({ commits: [], startHead: 2, github: { pr: null } });
    expect(await runPipeline(fromReview, h.deps)).toEqual({ kind: "failed", reason: "PR が無い" });
    expect(h.calls).toEqual([]);
  });

  test("--local 相当（GitHub 無し）では、PR を使わずにローカルの commit をレビューする", async () => {
    const h = pipelineHarness({ commits: [false], startHead: 2 });
    expect(await runPipeline(fromReview, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => c.kind)).toEqual(["review", "fix", "summarize"]);
    expect(h.calls[0]?.prompt).toContain("git diff sha0...HEAD");
  });

  test("修正があれば、実装からのときと同じく次のラウンドでレビューし直す", async () => {
    const h = pipelineHarness({ commits: [true, false], startHead: 2, github: { pr: 56 } });
    expect(await runPipeline(fromReview, h.deps)).toEqual({ kind: "done" });
    expect(h.stages.filter((s) => s.startsWith("reviewing"))).toHaveLength(2);
  });
});

describe("reviewFileName / specReviewFileName", () => {
  test("担当名でファイル名が決まり、同じエージェントをモデル違いで並べても衝突しない", () => {
    const a = reviewFileName(assignee("agy", "model-a"), 1);
    const b = reviewFileName(assignee("agy", "model-b"), 1);
    expect(a).toBe("review-1-agy-model-a.md");
    expect(b).toBe("review-1-agy-model-b.md");
    expect(a).not.toBe(b);

    const sa = specReviewFileName(assignee("agy", "model-a"), 1);
    expect(sa).toBe("spec-review-1-agy-model-a.md");
  });

  test("ファイル名に使えない文字を残さない", () => {
    expect(reviewFileName(assignee("claude", "a b", "c@high"), 2)).toBe(
      "review-2-claude-a-b-c-high.md",
    );
  });
});

describe("runPipeline: リポジトリごとのゲート実行", () => {
  const gateCfg = pipelineConfig(assignee("claude"), [assignee("agy")]);
  const none = () => `${VERDICT.none}\n- nit: よい`;

  test("ゲートなし: ログに「ゲートなし」と残して完了する", async () => {
    const h = pipelineHarness({ commits: [true, false], review: none, gates: [] });
    expect(await runPipeline(gateCfg, h.deps)).toEqual({ kind: "done" });
    expect(h.logs).toContain("ゲートなし");
    expect(h.calls.filter((c) => c.kind === "gate")).toHaveLength(0);
  });

  test("全合格で done: ゲートを実行し合格なら完了し、担当と判定が記録される", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: none,
      gates: [{ name: "e2e" }],
      gate: () => `${GATE_VERDICT.pass}\nE2E すべて成功`,
    });
    expect(await runPipeline(gateCfg, h.deps)).toEqual({ kind: "done" });
    const gates = h.calls.filter((c) => c.kind === "gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]?.output).toBe("gate-1-e2e.md");
    expect(h.deps.state.read("gate-1-e2e.md")).toContain(GATE_VERDICT.pass);
    expect(h.deps.state.read("gate-1-e2e.md")).toContain("担当: agy");
    expect(h.logs.some((l) => l.includes("ゲート (e2e): pass 担当: agy"))).toBe(true);
  });

  test("must を見送って HEAD が変わらない場合もゲートを実行する", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: () => VERDICT.must,
      gates: [{ name: "e2e" }],
    });
    expect(await runPipeline(gateCfg, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.filter((c) => c.kind === "gate")).toHaveLength(1);
  });

  test("対象外は合格扱い: 判定が「対象外」なら合格扱いで done になる", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: none,
      gates: [{ name: "preview" }],
      gate: () => `${GATE_VERDICT.skip}\n--local のため Preview なし`,
    });
    expect(await runPipeline(gateCfg, h.deps)).toEqual({ kind: "done" });
    expect(h.logs.some((l) => l.includes("ゲート (preview): skip"))).toBe(true);
  });

  test("不合格で修正 → CI と全ゲートをやり直す（レビューはしない）", async () => {
    const h = pipelineHarness({
      commits: [true, false, true, false],
      github: { pr: 56 },
      review: none,
      gates: [{ name: "e2e" }, { name: "perf" }],
      gate: (round, name) => {
        if (round === 1 && name === "e2e") return `${GATE_VERDICT.fail}\nログイン失敗`;
        return `${GATE_VERDICT.pass}\n成功`;
      },
    });
    expect(await runPipeline(gateCfg, h.deps)).toEqual({ kind: "done" });

    // round 1 で 2 つのゲート実行
    const round1Gates = h.calls.filter((c) => c.kind === "gate" && c.output?.startsWith("gate-1-"));
    expect(round1Gates).toHaveLength(2);

    // 修正担当のプロンプトにゲート不合格結果が渡る
    const fixes = h.calls.filter((c) => c.kind === "fix");
    const secondFix = fixes[1]!;
    expect(secondFix.prompt).toContain("ゲートの不合格結果: .autopilot/gate-1-e2e.md");

    // 不合格を直した後はレビューは走らず、全ゲートを再実行する
    const laterReviews = h.calls.filter(
      (c) => c.kind === "review" && !c.output?.startsWith("review-1-"),
    );
    expect(laterReviews).toHaveLength(0);

    const reGates = h.calls.filter((c) => c.kind === "gate" && c.output?.startsWith("gate-3-"));
    expect(reGates).toHaveLength(2);
    expect(h.logs).toContain("ゲートの不合格を直したので、次は CI と全ゲートを確かめる");
    expect(h.logs.filter((l) => l === "CI: pass")).toHaveLength(3);
  });

  test("判定不能で needs-human: 修正ループに入らず即座に終了する", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: none,
      gates: [{ name: "e2e" }],
      gate: () => `${GATE_VERDICT.inconclusive}\n外部システム 503 エラー`,
    });
    const o = await runPipeline(gateCfg, h.deps);
    expect(o.kind).toBe("needs-human");
    if (o.kind !== "needs-human") throw new Error("人間への引き継ぎを期待した");
    expect(o.reason).toContain("ゲートが判定不能: e2e");
    // 修正担当は呼ばれない
    expect(h.calls.filter((c) => c.kind === "fix")).toHaveLength(1); // 1周目の初期 fix のみで、ゲート不合格による追加 fix は呼ばれない
  });

  test("判定不能と不合格が混ざったら needs-human を優先する", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: none,
      gates: [{ name: "fail-gate" }, { name: "inconclusive-gate" }],
      gate: (_, name) =>
        name === "fail-gate"
          ? `${GATE_VERDICT.fail}\nバグあり`
          : `${GATE_VERDICT.inconclusive}\nタイムアウト`,
    });
    const o = await runPipeline(gateCfg, h.deps);
    expect(o.kind).toBe("needs-human");
    if (o.kind !== "needs-human") throw new Error("人間への引き継ぎを期待した");
    expect(o.reason).toContain("ゲートが判定不能: inconclusive-gate");
  });

  test("読めない判定で needs-human", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: none,
      gates: [{ name: "e2e" }],
      gate: () => "何らかの出力（判定ヘッダなし）",
    });
    const o = await runPipeline(gateCfg, h.deps);
    expect(o.kind).toBe("needs-human");
    if (o.kind !== "needs-human") throw new Error("人間への引き継ぎを期待した");
    expect(o.reason).toContain("ゲートの判定を読めない: e2e");
  });

  test("ゲート担当が全候補で失敗したら needs-human", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: none,
      gates: [{ name: "e2e" }],
      failAgent: (_, kind) => kind === "gate",
    });
    const o = await runPipeline(gateCfg, h.deps);
    expect(o.kind).toBe("needs-human");
    if (o.kind !== "needs-human") throw new Error("人間への引き継ぎを期待した");
    expect(o.reason).toContain("ゲート担当が全員失敗した: e2e");
  });

  test("不合格で HEAD が変わらず needs-human", async () => {
    const h = pipelineHarness({
      commits: [true, false, false],
      review: none,
      gates: [{ name: "e2e" }],
      gate: () => `${GATE_VERDICT.fail}\n壊れている`,
    });
    const o = await runPipeline(gateCfg, h.deps);
    expect(o.kind).toBe("needs-human");
    if (o.kind !== "needs-human") throw new Error("人間への引き継ぎを期待した");
    expect(o.reason).toContain("ゲートの不合格を直せなかった");
  });

  test("上限で needs-human: ゲート不合格が続き上限に達したら終了する", async () => {
    const h = pipelineHarness({
      commits: [true, true, true, true],
      review: none,
      gates: [{ name: "e2e" }],
      gate: () => `${GATE_VERDICT.fail}\nずっと失敗`,
    });
    const o = await runPipeline(gateCfg, h.deps);
    expect(o.kind).toBe("needs-human");
    if (o.kind !== "needs-human") throw new Error("人間への引き継ぎを期待した");
    expect(o.reason).toContain("修正ループが上限（3 回）に達した");
  });

  test("needs-human.md が書かれたら次の周に進まない", async () => {
    const h = pipelineHarness({
      commits: [true, true],
      review: () => `${VERDICT.must}\n- must: 権限エラー`,
    });
    // 修正担当のターンで needs-human.md を作成する
    const originalRunAgent = h.deps.runAgent;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const res = await originalRunAgent(inv, prompt, opts);
      if (prompt.includes("直すべきもの")) {
        h.deps.state.write(
          "needs-human.md",
          "外部環境の AWS 認証情報が設定されておらず、コード修正では対応できない\n詳細...",
        );
      }
      return res;
    };
    const o = await runPipeline(gateCfg, h.deps);
    expect(o.kind).toBe("needs-human");
    if (o.kind !== "needs-human") throw new Error("人間への引き継ぎを期待した");
    expect(o.reason).toBe("外部環境の AWS 認証情報が設定されておらず、コード修正では対応できない");
    // 修正担当の直後に終了し、round 2 には進まない
    expect(h.calls.at(-1)?.kind).toBe("summarize");
  });
});

describe("runPipeline: --from gate", () => {
  const fromGate = pipelineConfig(assignee("claude"), [assignee("agy")], { from: "gate" });

  test("複数ゲートは全担当が開始してから結果を待つ", async () => {
    const h = pipelineHarness({ commits: [], gates: [{ name: "a" }, { name: "b" }] });
    let release = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = h.deps.runAgent;
    let count = 0;
    h.deps.runAgent = async (inv, prompt, opts) => {
      if (opts?.output?.startsWith("gate-")) {
        if (++count === 2) release();
        await bothStarted;
      }
      return run(inv, prompt, opts);
    };
    expect(await runPipeline(fromGate, h.deps)).toEqual({ kind: "done" });
    expect(count).toBe(2);
    expect(h.calls[0]?.prompt).toContain("PR 番号はない");
  });

  test("PR の HEAD と CI が揃う前にゲートを始めない", async () => {
    const h = pipelineHarness({
      commits: [],
      startHead: 2,
      github: {
        pr: 56,
        snapshots: [() => ({ head: "sha1", checks: ["pass"] }), checks("pending"), checks("pass")],
      },
      gates: [{ name: "e2e" }],
    });
    expect(await runPipeline(fromGate, h.deps)).toEqual({ kind: "done" });
    expect(h.calls[0]?.kind).toBe("gate");
    expect(h.calls[0]?.at).toBe(60_000);
    expect(h.calls[0]?.prompt).toContain("PR 番号は #56");
  });

  test("ゲートの利用不能時だけレビュー順の次の担当へ切り替える", async () => {
    const roles = assignRoles({ level: "high" }, {});
    for (const failure of ["unavailable", "error"] as const) {
      const h = pipelineHarness({
        commits: [],
        gates: [{ name: "e2e" }],
        failure,
        failAgent: (inv, kind) => kind === "gate" && inv.agent === "claude",
      });
      const outcome = await runPipeline({ ...fromGate, ...roles }, h.deps);
      expect(outcome.kind).toBe(failure === "unavailable" ? "done" : "needs-human");
      expect(h.calls.filter((c) => c.kind === "gate").map((c) => c.inv.agent)).toEqual(
        failure === "unavailable" ? ["claude", "codex"] : ["claude"],
      );
    }
  });

  test("実装とレビューを飛ばし、CI を待ってからゲートだけを走らせる", async () => {
    const h = pipelineHarness({
      commits: [false],
      startHead: 2,
      github: { pr: 56 },
      gates: [{ name: "e2e" }],
      gate: () => `${GATE_VERDICT.pass}\n成功`,
    });
    expect(await runPipeline(fromGate, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => c.kind)).toEqual(["gate", "summarize"]);
    expect(h.stages.some((s) => s.startsWith("implementing"))).toBe(false);
    expect(h.stages.some((s) => s.startsWith("reviewing"))).toBe(false);
  });

  test("--from gate で不合格なら通常どおり修正ループへ入る", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      startHead: 2,
      github: { pr: 56 },
      gates: [{ name: "e2e" }],
      gate: (round) =>
        round === 1 ? `${GATE_VERDICT.fail}\n壊れている` : `${GATE_VERDICT.pass}\n成功`,
    });
    expect(await runPipeline(fromGate, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => c.kind)).toEqual(["gate", "fix", "gate", "summarize"]);
  });
});

describe("runPipeline: 担当の後に作業ツリーが綺麗かを確かめる", () => {
  const one = pipelineConfig(assignee("claude"), [assignee("agy")]);
  const none = () => `${VERDICT.none}\n- nit: よい`;

  test("実装担当が commit したうえでファイルを残したら、レビューへ進まず要約して needs-human", async () => {
    const h = pipelineHarness({
      commits: [true],
      github: { pr: 7 },
      dirtyOnSuccess: (_inv, kind) => kind === "implement",
    });
    expect(await runPipeline(one, h.deps)).toEqual({
      kind: "needs-human",
      reason: "実装担当の実行後、作業ツリーに未 commit のファイルが残っている: ?? left-1.txt",
    });
    expect(h.calls.map((c) => c.kind)).toEqual(["implement", "summarize"]);
    expect(h.calls.at(-1)?.prompt).toContain("PR #7");
    // 理由は run.log と status にしか無いので、要約担当にはプロンプトで渡す。
    expect(h.calls.at(-1)?.prompt).toContain(
      "今回の結果は「needs-human: 実装担当の実行後、作業ツリーに未 commit のファイルが残っている: ?? left-1.txt」",
    );
  });

  test("実装担当がファイルを残し PR も作らなかったときも、残ったファイルを理由にする", async () => {
    const h = pipelineHarness({
      commits: [true],
      github: { pr: null },
      dirtyOnSuccess: (_inv, kind) => kind === "implement",
    });
    const o = await runPipeline(one, h.deps);
    expect(o).toEqual({
      kind: "needs-human",
      reason: "実装担当の実行後、作業ツリーに未 commit のファイルが残っている: ?? left-1.txt",
    });
  });

  test("1 周目の修正で HEAD が変わってもファイルが残っていれば、次の周へ進まず needs-human", async () => {
    const h = pipelineHarness({
      commits: [true, true],
      gates: [{ name: "e2e" }],
      dirtyOnSuccess: (_inv, kind) => kind === "fix",
    });
    expect(await runPipeline(one, h.deps)).toEqual({
      kind: "needs-human",
      reason: "修正担当の実行後、作業ツリーに未 commit のファイルが残っている: ?? left-1.txt",
    });
    expect(h.calls.map((c) => c.kind)).toEqual(["implement", "review", "fix", "summarize"]);
  });

  test("2 周目以降の修正の後も確かめる", async () => {
    let fixes = 0;
    const h = pipelineHarness({
      commits: [true, true, true],
      dirtyOnSuccess: (_inv, kind) => kind === "fix" && ++fixes === 2,
    });
    expect(await runPipeline(one, h.deps)).toEqual({
      kind: "needs-human",
      reason: "修正担当の実行後、作業ツリーに未 commit のファイルが残っている: ?? left-1.txt",
    });
    expect(h.calls.filter((c) => c.kind === "fix")).toHaveLength(2);
    expect(h.calls.at(-1)?.kind).toBe("summarize");
  });

  test("残ったファイルが多ければ先頭の 5 件と残りの件数を理由に書く", async () => {
    const h = pipelineHarness({ commits: [true, false], review: none });
    let fixed = false;
    const run = h.deps.runAgent;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const r = await run(inv, prompt, opts);
      if (h.calls.at(-1)?.kind === "fix") fixed = true;
      return r;
    };
    h.deps.uncommitted = async () =>
      fixed ? Array.from({ length: 7 }, (_, i) => ` M src/f${i + 1}.ts`) : [];
    expect(await runPipeline(one, h.deps)).toEqual({
      kind: "needs-human",
      reason:
        "修正担当の実行後、作業ツリーに未 commit のファイルが残っている: M src/f1.ts, M src/f2.ts, M src/f3.ts, M src/f4.ts, M src/f5.ts ほか 2 件",
    });
  });

  test("needs-human.md とファイルの残りが重なったら、両方を理由に書く", async () => {
    const h = pipelineHarness({
      commits: [true, true],
      dirtyOnSuccess: (_inv, kind) => kind === "fix",
    });
    const run = h.deps.runAgent;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const r = await run(inv, prompt, opts);
      if (h.calls.at(-1)?.kind === "fix") h.deps.state.write("needs-human.md", "認証が無い\n");
      return r;
    };
    expect(await runPipeline(one, h.deps)).toEqual({
      kind: "needs-human",
      reason:
        "認証が無い。修正担当の実行後、作業ツリーに未 commit のファイルが残っている: ?? left-1.txt",
    });
  });

  test("ゲートがファイルを残したら、修正担当のものと取り違えず、ゲートの後で needs-human", async () => {
    const h = pipelineHarness({
      commits: [],
      gates: [{ name: "e2e" }],
      gate: () => `${GATE_VERDICT.fail}\n壊れている`,
      dirtyOnSuccess: (_inv, kind) => kind === "gate",
    });
    expect(await runPipeline({ ...one, from: "gate" }, h.deps)).toEqual({
      kind: "needs-human",
      reason: "ゲートの実行後、作業ツリーに未 commit のファイルが残っている: ?? left-1.txt",
    });
    expect(h.calls.map((c) => c.kind)).toEqual(["gate", "summarize"]);
  });

  test("ゲートの不合格を直した直後に上限へ達したら、CI と全ゲートを確かめていないと伝える", async () => {
    const h = pipelineHarness({
      commits: [true],
      github: { pr: 7 },
      gates: [{ name: "e2e" }],
      gate: () => `${GATE_VERDICT.fail}\n壊れている`,
    });
    expect(await runPipeline({ ...one, from: "gate", maxRounds: 1 }, h.deps)).toEqual({
      kind: "needs-human",
      reason: "修正ループが上限（1 回）に達した。最後の修正の CI と全ゲートを確かめていない",
    });
  });
});

describe("runPipeline: 仕様検討（--from spec）", () => {
  const specCfg = pipelineConfig(assignee("claude"), [assignee("agy")], { from: "spec" });

  test("確定して実装へ進む（仕様検討 → 仕様レビュー → 実装 → レビュー → 要約）", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    expect(await runPipeline(specCfg, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => `${c.inv.agent}:${c.kind}`)).toEqual([
      "claude:spec",
      "agy:specReview",
      "claude:implement",
      "agy:review",
      "claude:fix",
      "claude:summarize",
    ]);
    expect(h.stages).toContain("specifying (claude)");
    expect(h.stages).toContain("spec reviewing (round 1: agy)");
    expect(h.stages).toContain("implementing (claude)");
    expect(h.logs).toContain("仕様を確定した");

    // 実装・修正・レビュー・要約に spec.md が渡る
    const impl = h.calls.find((c) => c.kind === "implement")!;
    expect(impl.prompt).toContain(".autopilot/spec.md の仕様を実装");
    const rev = h.calls.find((c) => c.kind === "review")!;
    expect(rev.prompt).toContain(".autopilot/spec.md の仕様に照らす");
    const fix = h.calls.find((c) => c.kind === "fix")!;
    expect(fix.prompt).toContain(".autopilot/spec.md の仕様を読み");
    const sum = h.calls.find((c) => c.kind === "summarize")!;
    expect(sum.prompt).toContain(".autopilot/spec.md");
  });

  test("修正の周と上限（1周目 must あり → 2周目で直って確定）", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      specReview: (round) =>
        round === 1 ? `${VERDICT.must}\n- must: 要修正` : `${VERDICT.none}\n- 指摘なし`,
    });
    expect(await runPipeline(specCfg, h.deps)).toEqual({ kind: "done" });
    const specCalls = h.calls.filter((c) => c.kind === "spec");
    expect(specCalls).toHaveLength(2); // 最初 + 修正
    expect(specCalls[1]?.session).toEqual({ kind: "resume", id: "conv1" });
    expect(specCalls[1]?.prompt).toContain("spec-review-1-agy.md");
    // 実装は検討の会話を引き継がない
    const impl = h.calls.find((c) => c.kind === "implement")!;
    expect(impl.session).toEqual({ kind: "start" });
    expect(h.stages).toContain("spec fixing (round 1)");
    expect(h.stages).toContain("spec reviewing (round 2: agy)");
    expect(h.logs).toContain("仕様を確定した");
  });

  test("仕様レビューの must が上限（2 周）まで残ったら needs-human で要約へ進む（実装は呼ばれない）", async () => {
    const h = pipelineHarness({
      commits: [true],
      specReview: () => `${VERDICT.must}\n- must: 直らない`,
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome).toEqual({
      kind: "needs-human",
      reason: "仕様レビューの must が上限まで残った",
    });
    expect(h.calls.some((c) => c.kind === "implement")).toBe(false);
    expect(h.calls.at(-1)?.kind).toBe("summarize");
    expect(h.calls.at(-1)?.prompt).toContain("needs-human: 仕様レビューの must が上限まで残った");
  });

  test("needs-human.md による needs-human（検討担当が判断を求めたら要約へ進む）", async () => {
    const h = pipelineHarness({
      commits: [true],
      initialFiles: { "needs-human.md": "仕様の選択肢 A または B\n" },
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome).toEqual({
      kind: "needs-human",
      reason: "仕様の選択肢 A または B",
    });
    expect(h.calls.some((c) => c.kind === "implement")).toBe(false);
    expect(h.calls.at(-1)?.kind).toBe("summarize");
  });

  test("検討担当が異常終了したら failed", async () => {
    const h = pipelineHarness({
      commits: [],
      failAgent: (_, k) => k === "spec",
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "仕様検討担当が異常終了した",
    });
  });

  test("spec.md が書かれなかったら failed", async () => {
    const h = pipelineHarness({
      commits: [],
      writeSpec: false,
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "spec.md が書かれなかった",
    });
  });

  test("前回の spec.md があれば spec-prev.md に移し下書きとして渡す", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      initialFiles: { "spec.md": "# 前回の仕様内容" },
    });
    expect(await runPipeline(specCfg, h.deps)).toEqual({ kind: "done" });
    const specCall = h.calls.find((c) => c.kind === "spec")!;
    expect(specCall.prompt).toContain(".autopilot/spec-prev.md");
    expect(h.deps.state.read("spec-prev.md")).toBe("# 前回の仕様内容");
  });

  test("仕様レビュー担当が全員失敗したら needs-human", async () => {
    const h = pipelineHarness({
      commits: [],
      failAgent: (_, k) => k === "specReview",
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome).toEqual({
      kind: "needs-human",
      reason: "仕様レビュー担当が全員失敗した",
    });
    expect(h.calls.some((c) => c.kind === "implement")).toBe(false);
  });

  test("作業ツリーに未 commit のファイルが残っていれば needs-human", async () => {
    const h = pipelineHarness({
      commits: [],
      dirtyOnSuccess: (_, k) => k === "spec",
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome.kind).toBe("needs-human");
    if (outcome.kind === "needs-human") {
      expect(outcome.reason).toContain(
        "仕様検討担当の実行後、作業ツリーに未 commit のファイルが残っている",
      );
    }
    expect(h.calls.some((c) => c.kind === "implement")).toBe(false);
  });

  test("仕様ファイルの渡し方: --from implement では spec.md があっても request.md を渡す", async () => {
    const fromImpl = pipelineConfig(assignee("claude"), [assignee("agy")], { from: "implement" });
    const h = pipelineHarness({
      commits: [true, false],
      initialFiles: { "spec.md": "# 古い仕様" },
    });
    expect(await runPipeline(fromImpl, h.deps)).toEqual({ kind: "done" });
    const impl = h.calls.find((c) => c.kind === "implement")!;
    expect(impl.prompt).toContain(".autopilot/request.md の仕様を実装");
    expect(impl.prompt).not.toContain(".autopilot/spec.md");
    const fix = h.calls.find((c) => c.kind === "fix")!;
    expect(fix.prompt).toContain(".autopilot/request.md の仕様を読み");
  });

  test("重複するレビュー担当名や連番風の担当名があっても一意なファイル名を割り当てる", () => {
    const rvs = [
      assignee("claude", "MODEL"),
      assignee("claude", "MODEL"),
      assignee("claude", "MODEL-2"),
    ];
    const names = reviewFileNames(rvs, 1);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe("review-1-claude-MODEL.md");
    expect(names[1]).toBe("review-1-claude-MODEL-2.md");
    expect(names[2]).toBe("review-1-claude-MODEL-2-2.md");

    const specNames = specReviewFileNames(rvs, 2);
    expect(new Set(specNames).size).toBe(3);
  });

  test("safeAssigneeSlug: 長いモデル指定でも安全な長さに短縮する", () => {
    const longName = `claude:${"m".repeat(300)}`;
    const slug = safeAssigneeSlug(longName);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toMatch(/^claude-m+-/);
  });

  test("仕様検討開始前に未 commit のファイルがあれば検討担当を起動せず needs-human。古い spec.md があっても要約には渡さない", async () => {
    const h = pipelineHarness({
      commits: [],
      initialDirty: 1,
      initialFiles: { "spec.md": "# 前回の古い仕様" },
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome.kind).toBe("needs-human");
    if (outcome.kind === "needs-human") {
      expect(outcome.reason).toContain(
        "仕様検討の開始前、作業ツリーに未 commit のファイルが残っている",
      );
    }
    expect(h.calls.some((c) => c.kind === "spec")).toBe(false);
    // 古い spec.md ではなく request.md が要約に渡る
    const summarizeCall = h.calls.find((c) => c.kind === "summarize")!;
    expect(summarizeCall.prompt).toContain(".autopilot/request.md");
    expect(summarizeCall.prompt).not.toContain(".autopilot/spec.md");
    // 前回の spec.md は退避されている
    expect(h.deps.state.read("spec.md")).toBeNull();
    expect(h.deps.state.read("spec-prev.md")).toBe("# 前回の古い仕様");
  });

  test("前回の spec.md がなく spec-prev.md だけがある場合も下書きとして引き継ぐ", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      initialFiles: { "spec-prev.md": "# 過去の下書き" },
    });
    expect(await runPipeline(specCfg, h.deps)).toEqual({ kind: "done" });
    const specCall = h.calls.find((c) => c.kind === "spec")!;
    expect(specCall.prompt).toContain(".autopilot/spec-prev.md があれば下書きとして参考にしてよい");
  });

  test("仕様修正で会話 ID が読めなければ新しい会話で始めログに残す", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      specReview: (round) => (round === 1 ? VERDICT.must : VERDICT.none),
      omitSession: (_, k) => k === "spec",
    });
    expect(await runPipeline(specCfg, h.deps)).toEqual({ kind: "done" });
    expect(h.logs).toContain("検討担当の会話 ID が読めないため、新しい会話で始める");
  });

  test("仕様検討で needs-human 時、書かれた spec.md が要約プロンプトに渡り、要約失敗ログが残る", async () => {
    const h = pipelineHarness({
      commits: [],
      failAgent: (_, k) => k === "specReview" || k === "summarize",
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome.kind).toBe("needs-human");
    const summarizeCall = h.calls.find((c) => c.kind === "summarize")!;
    expect(summarizeCall.prompt).toContain(".autopilot/spec.md");
    expect(h.logs).toContain("要約担当が異常終了した");
  });

  test("仕様検討で needs-human 時、既存 PR があれば PR 番号と更新指示が要約に渡る", async () => {
    const h = pipelineHarness({
      commits: [],
      failAgent: (_, k) => k === "specReview",
      github: { pr: 15 },
    });
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome.kind).toBe("needs-human");
    const summarizeCall = h.calls.find((c) => c.kind === "summarize")!;
    expect(summarizeCall.prompt).toContain(
      "PR #15 の本文も同じ内容で gh pr edit --body により更新する",
    );
  });

  test("仕様検討で needs-human 時、PR 番号の取得で例外が起きても failed にならず pr=null で要約が作成される", async () => {
    const h = pipelineHarness({
      commits: [],
      failAgent: (_, k) => k === "specReview",
      github: { pr: 15 },
    });
    h.deps.github!.prNumber = async () => {
      throw new Error("GitHub 通信エラー");
    };
    const outcome = await runPipeline(specCfg, h.deps);
    expect(outcome.kind).toBe("needs-human");
    const summarizeCall = h.calls.find((c) => c.kind === "summarize")!;
    expect(summarizeCall.prompt).not.toContain("gh pr edit --body");
    expect(h.logs).toContain(
      "PR 番号の取得に失敗した (GitHub 通信エラー)。PR 本文の更新は行わず要約を作成する",
    );
  });
});
