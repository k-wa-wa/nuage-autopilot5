import { describe, expect, test } from "bun:test";
import * as prompts from "./prompts.ts";
import { kindOf, MARKERS } from "./testing/helpers.ts";

const all = {
  implement: prompts.implement("pr"),
  review: prompts.review({ baseSha: "abc123", since: null }),
  fix: prompts.fix({
    mode: "pr",
    scope: "must-should",
    reviews: [".autopilot/review-1-agy.md"],
    ciLog: null,
    inbox: null,
  }),
  summarize: prompts.summarize("abc123", 7),
};

describe("プロンプト", () => {
  test("種類ごとの目印がちょうど 1 つ入っている（偽のエージェントが役割を見分ける）", () => {
    for (const [kind, prompt] of Object.entries(all)) {
      expect(kindOf(prompt)).toBe(kind as keyof typeof MARKERS);
      const hits = Object.values(MARKERS).filter((m) => prompt.includes(m));
      expect(hits).toHaveLength(1);
    }
  });

  test("PR モードは push と PR 作成を指示し、Draft を禁じる", () => {
    expect(prompts.implement("pr")).toContain("push");
    expect(prompts.implement("pr")).toContain("gh pr create");
    expect(prompts.implement("pr")).toContain("Draft にはしない");
  });

  test("--local は push も PR 作成もさせない", () => {
    for (const p of [
      prompts.implement("local"),
      prompts.fix({ mode: "local", scope: "must-should", reviews: [], ciLog: null, inbox: null }),
    ]) {
      expect(p).toContain("push と PR 作成はしない");
      expect(p).not.toContain("gh pr create");
    }
  });

  test("レビューは基点からの差分を読ませ、ファイルを変えさせない", () => {
    expect(all.review).toContain("git diff abc123...HEAD");
    expect(all.review).toContain("ファイルは一切変更しない");
    expect(all.review).toContain("判定: must なし");
  });

  test("レビューは指摘が無くても、何を確かめたかを書かせる（浅いレビューを見分ける）", () => {
    expect(all.review).toContain("指摘の有無にかかわらず");
    expect(all.review).toContain("確かめたこと:");
    expect(all.review).not.toContain("とだけ出力する");
  });

  test("修正には、渡されたものだけを並べる（優先度つき）", () => {
    const p = prompts.fix({
      mode: "pr",
      scope: "must-should",
      reviews: [".autopilot/review-1-agy.md", ".autopilot/review-1-copilot.md"],
      ciLog: ".autopilot/ci-fail-1.log",
      inbox: ".autopilot/inbox-1.md",
    });
    expect(p).toContain("人間からの追加指示: .autopilot/inbox-1.md（最優先）");
    expect(p).toContain("CI の失敗ログ: .autopilot/ci-fail-1.log（必ず直す）");
    expect(p).toContain(".autopilot/review-1-agy.md, .autopilot/review-1-copilot.md");
    expect(all.fix).not.toContain("追加指示");
    expect(all.fix).not.toContain("CI の失敗ログ");
  });

  test("要約は PR があるときだけ PR 本文も更新させる", () => {
    expect(prompts.summarize("abc", 7)).toContain("PR #7 の本文");
    expect(prompts.summarize("abc", null)).not.toContain("PR #");
  });

  test("レビューは 1 行目に must の有無を書かせ、重要度の基準を示す", () => {
    expect(all.review).toContain(`「${prompts.VERDICT.must}」か「${prompts.VERDICT.none}」`);
    expect(all.review).toContain("must: 仕様を満たさない");
  });

  test("レビューは差分を疑って読み、具体的な批判的観点をすべて点検させる", () => {
    expect(all.review).toContain("差分を疑って読み、壊れるシナリオや盲点を積極的に探す");
    for (const aspect of [
      "仕様の充足",
      "過剰な変更（頼まれていない変更）",
      "エッジケース・境界値・異常系",
      "null・空値・タイムアウト・リソースリーク・エラー処理",
      "セキュリティ・権限・秘密情報",
      "AGENTS.md",
      "副作用・退行（Regression）",
      "テストの妥当性と十分性",
    ]) {
      expect(all.review).toContain(aspect);
    }
  });

  test("レビューは must が無くても should や nit を積極的に挙げさせる（1 行目の判定で抑制させない）", () => {
    expect(all.review).toContain("should や nit として積極的に挙げる");
    expect(all.review).toContain("should や nit があれば「指摘なし」とせず続けてすべて書く");
  });

  test("レビューは decisions.md の見送りを繰り返させない", () => {
    expect(all.review).toContain(".autopilot/decisions.md");
    expect(all.review).toContain("繰り返さない");
  });

  test("2 周目以降のレビューは、前回レビューした HEAD からの修正を示す", () => {
    const p = prompts.review({ baseSha: "abc", since: "def" });
    expect(p).toContain("git diff abc...HEAD");
    expect(p).toContain("git diff def..HEAD");
    expect(all.review).not.toContain("前回のレビュー");
  });

  test("修正の範囲: 1 周目は should まで、2 周目以降は must だけ。nit は直させない", () => {
    const base = { mode: "pr" as const, reviews: [], ciLog: null, inbox: null };
    expect(prompts.fix({ ...base, scope: "must-should" })).toContain(
      "must と should を直す。nit は直さない",
    );
    expect(prompts.fix({ ...base, scope: "must" })).toContain(
      "must だけを直す。should と nit は直さない",
    );
  });

  test("修正は、変更しないことを失敗と思わせない", () => {
    expect(all.fix).toContain("変更しないことは失敗ではない");
  });
});

describe("reviewHasMust", () => {
  test("1 行目が must なしの判定なら false", () => {
    expect(prompts.reviewHasMust(`${prompts.VERDICT.none}\n- nit: x`)).toBe(false);
  });

  test("Markdown の装飾や前の空行があっても判定を読む", () => {
    expect(prompts.reviewHasMust(`\n\n**${prompts.VERDICT.none}**\n`)).toBe(false);
    expect(prompts.reviewHasMust(`# ${prompts.VERDICT.none}`)).toBe(false);
    expect(prompts.reviewHasMust("判定:must なし")).toBe(false);
  });

  test("must ありの判定なら true", () => {
    expect(prompts.reviewHasMust(`${prompts.VERDICT.must}\n- must: x`)).toBe(true);
  });

  test("判定が読めなければ、見落とさないよう must ありとみなす", () => {
    expect(prompts.reviewHasMust("")).toBe(true);
    expect(prompts.reviewHasMust("指摘なし")).toBe(true);
    expect(prompts.reviewHasMust(`前置き\n${prompts.VERDICT.none}`)).toBe(true);
  });
});
