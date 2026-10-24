import { describe, expect, test } from "bun:test";
import { CI_LIMITS } from "./ci.ts";
import { type Config, reviewFileName, runPipeline } from "./pipeline.ts";
import { checks, pipelineHarness } from "./testing/helpers.ts";

const cfg: Config = {
  impl: { agent: "claude" },
  reviewers: [{ agent: "agy" }, { agent: "copilot" }],
  maxRounds: 3,
  baseSha: "sha0",
};

describe("runPipeline: 基本の流れ", () => {
  test("実装 → レビュー → 直すもの無しで完了し、最後に要約する", async () => {
    const h = pipelineHarness({ commits: [true, false] });
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.map((c) => `${c.spec.agent}:${c.kind}`)).toEqual([
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

describe("reviewFileName", () => {
  test("同じエージェントをモデル違いで並べても衝突しない", () => {
    const a = reviewFileName({ agent: "agy", model: "gemini-3.8-flash-high" }, 1);
    const b = reviewFileName({ agent: "agy", model: "gemini-3.8-pro" }, 1);
    expect(a).not.toBe(b);
    expect(a).toBe("review-1-agy-gemini-3.8-flash-high.md");
  });

  test("ファイル名に使えない文字を残さない", () => {
    expect(reviewFileName({ agent: "claude", model: "a/b c" }, 2)).toBe("review-2-claude-a-b-c.md");
  });
});
