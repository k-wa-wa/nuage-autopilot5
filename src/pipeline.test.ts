import { describe, expect, test } from "bun:test";
import { CI_LIMITS } from "./ci.ts";
import { reviewFileName, runPipeline } from "./pipeline.ts";
import { assignee, checks, pipelineConfig, pipelineHarness } from "./testing/helpers.ts";

const cfg = pipelineConfig(assignee("claude"), [assignee("agy"), assignee("copilot")]);

describe("runPipeline: 基本の流れ", () => {
  test("実装 → レビュー → 直すもの無しで完了し、最後に要約する", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => `${c.inv.agent}:${c.kind}`)).toEqual([
      "claude:implement",
      "agy:review",
      "copilot:review",
      "claude:fix",
      "claude:summarize",
    ]);
  });

  test("レビューは担当ごとに別ファイルへ保存し、修正のプロンプトに全部渡す", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    await runPipeline(cfg, h.deps);
    expect(h.calls.filter((c) => c.kind === "review").map((c) => c.output)).toEqual([
      "review-1-agy.md",
      "review-1-copilot.md",
    ]);
    const fix = h.calls.find((c) => c.kind === "fix")!;
    expect(fix.prompt).toContain(".autopilot/review-1-agy.md");
    expect(fix.prompt).toContain(".autopilot/review-1-copilot.md");
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
    expect(h.stages.filter((s) => s.startsWith("waiting CI"))).toHaveLength(2);
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
    expect(fix.prompt).toContain("review-1-copilot.md");
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

describe("reviewFileName", () => {
  test("同じエージェントをモデル違いで並べても衝突しない", () => {
    const a = reviewFileName(assignee("agy", "model-a"), 1);
    const b = reviewFileName(assignee("agy", "model-b"), 1);
    expect(a).not.toBe(b);
    expect(a).toBe("review-1-agy-model-a.md");
  });

  test("ファイル名に使えない文字を残さない", () => {
    expect(reviewFileName(assignee("claude", "a b", "c@high"), 2)).toBe(
      "review-2-claude-a-b-c-high.md",
    );
  });
});
