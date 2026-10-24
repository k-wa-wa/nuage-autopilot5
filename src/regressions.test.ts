import { describe, expect, test } from "bun:test";
import { buildArgv } from "./agents.ts";
import { judgeCi } from "./ci.ts";
import { parseChecks } from "./github.ts";
import { parseStartOptions } from "./main.ts";
import { reviewFileName, runPipeline } from "./pipeline.ts";
import { checks, pipelineHarness } from "./testing/helpers.ts";

/**
 * 実際に踏んだ欠陥の回帰テスト。
 * どれも「型では防げず、動かして初めて分かる」種類のものだった。
 */

describe("agy が --model をプロンプトとして読んだ", () => {
  // agy の -p は直後の引数をプロンプトとして読む。`agy -p --model m PROMPT` は
  // 「-p took "--model" as its prompt」になった。
  test("どのエージェントも -p の直後がプロンプト", () => {
    for (const agent of ["claude", "agy", "copilot"] as const) {
      expect(buildArgv({ agent, model: "m" }, "PROMPT").slice(-2)).toEqual(["-p", "PROMPT"]);
    }
  });
});

describe("--max-rounds に数字以外を渡すとレビューせずに done になった", () => {
  // Number("abc") は NaN で、for (round <= NaN) が 1 回も回らなかった。
  test("起動前に拒否する", async () => {
    await expect(
      parseStartOptions({ impl: "claude", "max-rounds": "abc", local: true }, async () => true),
    ).rejects.toThrow(/max-rounds/);
  });
});

describe("レビュー担当が 0 人でも done になった", () => {
  test("全員が失敗したら人間に戻す", async () => {
    const h = pipelineHarness({ commits: [true], failAgent: (_, k) => k === "review" });
    const o = await runPipeline(
      { impl: { agent: "claude" }, reviewers: [{ agent: "agy" }], maxRounds: 3, baseSha: "sha0" },
      h.deps,
    );
    expect(o.kind).toBe("needs-human");
  });
});

describe("同じエージェントのモデル違いのレビューが同じファイルに上書きされた", () => {
  test("ファイル名にモデルを含める", () => {
    expect(reviewFileName({ agent: "agy", model: "a" }, 1)).not.toBe(
      reviewFileName({ agent: "agy", model: "b" }, 1),
    );
  });
});

describe("push 直後の CI を読み違えた", () => {
  test("CI がまだ登録されていないだけなのに、CI 無しとして先へ進んだ", () => {
    expect(judgeCi({ head: "a", checks: [] }, "a", 0).kind).toBe("wait");
  });

  test("PR の HEAD が古いまま、前のコミットの緑を読んだ", () => {
    expect(judgeCi({ head: "old", checks: ["pass"] }, "new", 0).kind).toBe("wait");
  });

  test("gh pr checks の「CI 無し」は終了コード 1 で返るので、失敗と区別する", () => {
    // 実際の gh 2.63 の出力
    expect(
      parseChecks({ code: 1, stdout: "", stderr: "no checks reported on the 'feature/x' branch" }),
    ).toEqual([]);
  });

  test("修正を push した後の新しいコミットの CI を待つ", async () => {
    const h = pipelineHarness({
      commits: [true, true, false],
      github: {
        pr: 7,
        // 修正（sha2）の push が反映されるまで、PR は sha1 の緑を返し続ける
        snapshots: [checks("fail"), () => ({ head: "sha1", checks: ["pass"] }), checks("fail")],
      },
    });
    const o = await runPipeline(
      { impl: { agent: "claude" }, reviewers: [{ agent: "agy" }], maxRounds: 3, baseSha: "sha0" },
      h.deps,
    );
    expect(o).toEqual({ kind: "needs-human", reason: "CI の失敗を直せなかった" });
  });
});
