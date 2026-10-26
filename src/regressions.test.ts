import { describe, expect, test } from "bun:test";
import { buildArgv } from "./agents.ts";
import { judgeCi } from "./ci.ts";
import { parseChecks, parsePrNumber } from "./github.ts";
import { parseStartOptions } from "./main.ts";
import { reviewFileName, runPipeline } from "./pipeline.ts";
import * as prompts from "./prompts.ts";
import { VERDICT } from "./prompts.ts";
import {
  assignee,
  checks,
  GH_NO_AUTH,
  GH_NO_PR,
  pipelineConfig,
  pipelineHarness,
} from "./testing/helpers.ts";

/**
 * 実際に踏んだ欠陥の回帰テスト。
 * どれも「型では防げず、動かして初めて分かる」種類のものだった。
 */

describe("agy が --model をプロンプトとして読んだ", () => {
  // agy の -p は直後の引数をプロンプトとして読む。`agy -p --model m PROMPT` は
  // 「-p took "--model" as its prompt」になった。
  test("どのエージェントも -p の直後がプロンプト", () => {
    for (const agent of ["claude", "agy", "copilot"] as const) {
      expect(buildArgv({ agent, model: "m", effort: "high" }, "PROMPT").slice(-2)).toEqual([
        "-p",
        "PROMPT",
      ]);
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
    const o = await runPipeline(pipelineConfig(assignee("claude"), [assignee("agy")]), h.deps);
    expect(o.kind).toBe("needs-human");
  });
});

describe("同じエージェントのモデル違いのレビューが同じファイルに上書きされた", () => {
  test("ファイル名にモデルを含める", () => {
    expect(reviewFileName(assignee("agy", "a"), 1)).not.toBe(
      reviewFileName(assignee("agy", "b"), 1),
    );
  });
});

describe("レビューが毎回「指摘なし」の 1 行だけで、確かめた範囲が分からなかった（pechka #75 の試運転）", () => {
  // プロンプトが「問題が無ければ『指摘なし』とだけ出力する」だったので、浅いレビューと見分けられなかった。
  test("指摘が無くても、確かめたことを書かせる", () => {
    const p = prompts.review({ baseSha: "abc", since: null });
    expect(p).toContain("確かめたこと:");
    expect(p).not.toContain("とだけ出力する");
  });
});

describe("既存の PR の続きでは、実装担当が何も commit しなくても成功になった（pechka #75 の試運転）", () => {
  // 基点（既定ブランチ）と比べていたので、もとから進んでいるブランチでは常に「commit あり」に見えた。
  test("実装の直前の HEAD と比べる", async () => {
    const h = pipelineHarness({ commits: [false], startHead: 1, github: { pr: 75 } });
    const o = await runPipeline(pipelineConfig(assignee("claude"), [assignee("agy")]), h.deps);
    expect(o).toEqual({ kind: "failed", reason: "何も commit されなかった" });
  });
});

describe("agy の既定モデルが利用上限に達し、レビュー担当が全員失敗した（pechka #74 の試運転）", () => {
  // agy は他のモデルなら使えたのに、既定モデル 1 つで決め打ちしていたので人間に戻った。
  test("並びの次のモデルでレビューを続ける", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      failAgent: (inv, k) => k === "review" && inv.model === "exhausted",
    });
    const o = await runPipeline(
      pipelineConfig(assignee("claude"), [assignee("agy", "exhausted", "available")]),
      h.deps,
    );
    expect(o).toEqual({ kind: "done" });
    expect(h.calls.filter((c) => c.kind === "review").map((c) => c.inv.model)).toEqual([
      "exhausted",
      "available",
    ]);
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
    const o = await runPipeline(pipelineConfig(assignee("claude"), [assignee("agy")]), h.deps);
    expect(o).toEqual({ kind: "needs-human", reason: "CI の失敗を直せなかった" });
  });
});

describe("gh の認証エラーが「PR が作られなかった」に化けた（nuage-cluster #56）", () => {
  // GH_TOKEN の無いシェルから起動し、gh pr view が認証エラーで落ちた。PR はできていたのに、
  // prNumber が失敗をすべて null にしていたので「PR が無い」と区別がつかなかった。
  test("認証エラー（exit 4）は gh の stderr を付けて例外にする", () => {
    expect(() => parsePrNumber({ code: 4, stdout: "", stderr: GH_NO_AUTH })).toThrow(
      /gh auth login/,
    );
  });

  test("PR が無い（exit 1・no pull requests found）ときだけ null にする", () => {
    expect(parsePrNumber({ code: 1, stdout: "", stderr: GH_NO_PR })).toBeNull();
  });

  test("例外はパイプラインを止める（PR が無いことにして先へ進まない）", async () => {
    const h = pipelineHarness({ commits: [true], github: { pr: 56 } });
    h.deps.github!.prNumber = async () =>
      parsePrNumber({ code: 4, stdout: "", stderr: GH_NO_AUTH });
    await expect(
      runPipeline(pipelineConfig(assignee("claude"), [assignee("agy")]), h.deps),
    ).rejects.toThrow(/gh auth login/);
    expect(h.calls.map((c) => c.kind)).toEqual(["implement"]);
  });
});

describe("既存の PR のレビューから再開できなかった（nuage-cluster #56）", () => {
  // 実装担当は「PR は足りている」と判断して commit せず、「何も commit されなかった」で終わった。
  // commit が無いのを失敗にするのは意図どおりで、再開する手段が無かったことが欠陥だった。
  test("--from review は実装担当を呼ばず、PR に対してレビューを走らせる", async () => {
    const h = pipelineHarness({ commits: [false], startHead: 3, github: { pr: 56 } });
    const o = await runPipeline(
      pipelineConfig(assignee("claude"), [assignee("agy")], { from: "review" }),
      h.deps,
    );
    expect(o).toEqual({ kind: "done" });
    expect(h.calls.some((c) => c.kind === "implement")).toBe(false);
    expect(h.calls.filter((c) => c.kind === "review")).toHaveLength(1);
    expect(h.logs).toContain("PR #56");
  });

  test("--from implement で commit が無ければ、今までどおり失敗にする", async () => {
    const h = pipelineHarness({ commits: [false], startHead: 3, github: { pr: 56 } });
    const o = await runPipeline(pipelineConfig(assignee("claude"), [assignee("agy")]), h.deps);
    expect(o).toEqual({ kind: "failed", reason: "何も commit されなかった" });
  });
});

describe("must の無いラウンドでも修正が commit し続け、上限の 3 周まで回った（nuage-cluster #63、nuage-monitoring-stack #15）", () => {
  // 終わる条件が「修正担当が何も commit しない」だけだった。修正担当は nit まで直して commit し、
  // その修正に次のレビューがまた nit を付けた。2・3 周目に must は 1 件も無かったのに、1 時間かかった。
  test("must の無いレビューの後は、再レビューせずに終える", async () => {
    const h = pipelineHarness({
      commits: [true, true, true, true],
      review: () => `${VERDICT.none}\n- should: x\n- nit: y`,
    });
    const o = await runPipeline(pipelineConfig(assignee("agy"), [assignee("claude")]), h.deps);
    expect(o).toEqual({ kind: "done" });
    expect(h.calls.filter((c) => c.kind === "review")).toHaveLength(1);
  });

  test("修正担当が見送った指摘を、レビュー担当が毎周繰り返した", () => {
    // レビュー担当は decisions.md を読んでいなかった。
    expect(prompts.review({ baseSha: "abc", since: "def" })).toContain(".autopilot/decisions.md");
  });
});
