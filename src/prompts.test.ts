import { describe, expect, test } from "bun:test";
import * as prompts from "./prompts.ts";
import { kindOf, MARKERS } from "./testing/helpers.ts";

const all = {
  implement: prompts.implement("pr"),
  review: prompts.review("abc123"),
  fix: prompts.fix({
    mode: "pr",
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
      prompts.fix({ mode: "local", reviews: [], ciLog: null, inbox: null }),
    ]) {
      expect(p).toContain("push と PR 作成はしない");
      expect(p).not.toContain("gh pr create");
    }
  });

  test("レビューは基点からの差分を読ませ、ファイルを変えさせない", () => {
    expect(all.review).toContain("git diff abc123...HEAD");
    expect(all.review).toContain("ファイルは一切変更しない");
    expect(all.review).toContain("指摘なし");
  });

  test("レビューは指摘が無くても、何を確かめたかを書かせる（浅いレビューを見分ける）", () => {
    expect(all.review).toContain("指摘の有無にかかわらず");
    expect(all.review).toContain("確かめたこと:");
    expect(all.review).not.toContain("とだけ出力する");
  });

  test("修正には、渡されたものだけを並べる（優先度つき）", () => {
    const p = prompts.fix({
      mode: "pr",
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
});
