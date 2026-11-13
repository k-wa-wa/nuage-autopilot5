import { describe, expect, test } from "bun:test";
import * as prompts from "./prompts.ts";
import { kindOf, MARKERS } from "./testing/helpers.ts";

const all = {
  implement: prompts.implement("pr"),
  reviewFree: prompts.review("free", { baseSha: "abc123", since: null }),
  reviewCoverage: prompts.review("coverage", { baseSha: "abc123", since: null }),
  gate: prompts.gate({
    name: "e2e",
    sourcePath: ".autopilot/gate-src-e2e.md",
    baseSha: "abc123",
    pr: 7,
  }),
  fix: prompts.fix({
    mode: "pr",
    scope: "must-should",
    reviews: [".autopilot/review-1-free.md", ".autopilot/review-1-coverage.md"],
    ciLog: null,
    inbox: null,
  }),
  summarize: prompts.summarize("abc123", 7),
};

describe("プロンプト", () => {
  test("種類ごとの目印がちょうど 1 つ入っている（偽のエージェントが役割を見分ける）", () => {
    for (const [kind, prompt] of Object.entries(all)) {
      const expectedKind = kind.startsWith("review") ? "review" : (kind as keyof typeof MARKERS);
      expect(kindOf(prompt)).toBe(expectedKind);
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

  test("2 観点のレビュープロンプトは共通の約束を含む（差分読解・ファイル非変更・1行目判定・確かめたこと・decisions.md）", () => {
    for (const p of [all.reviewFree, all.reviewCoverage]) {
      expect(p).toContain("git diff abc123...HEAD");
      expect(p).toContain("ファイルは一切変更しない");
      expect(p).toContain(`「${prompts.VERDICT.must}」か「${prompts.VERDICT.none}」`);
      expect(p).toContain("ほかの語は足さない");
      expect(p).toContain("must: 仕様を満たさない");
      expect(p).toContain("should や nit として積極的に挙げる");
      expect(p).toContain("指摘の有無にかかわらず");
      expect(p).toContain("確かめたこと:");
      expect(p).toContain(".autopilot/decisions.md");
      expect(p).toContain("繰り返さない");
    }
  });

  test("自由レビューは観点一覧を与えず壊れるシナリオを探させる", () => {
    expect(all.reviewFree).toContain("この変更がマージされたら何が壊れるか");
    expect(all.reviewFree).toContain("観点の一覧は与えない");
    expect(all.reviewFree).not.toContain("仕様の充足");
    expect(all.reviewFree).not.toContain("エッジケース・境界値・異常系");
  });

  test("網羅レビューは具体的な批判的観点（6 観点チェックリスト）をすべて点検させる", () => {
    expect(all.reviewCoverage).toContain("差分を疑って読み、壊れるシナリオや盲点を積極的に探す");
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
      expect(all.reviewCoverage).toContain(aspect);
    }
  });

  test("修正には、渡されたものだけを並べる（優先度つき）", () => {
    const p = prompts.fix({
      mode: "pr",
      scope: "must-should",
      reviews: [".autopilot/review-1-free.md", ".autopilot/review-1-coverage.md"],
      ciLog: ".autopilot/ci-fail-1.log",
      inbox: ".autopilot/inbox-1.md",
      gateLogs: [".autopilot/gate-1-e2e.md"],
    });
    expect(p).toContain("人間からの追加指示: .autopilot/inbox-1.md（最優先）");
    expect(p).toContain("CI の失敗ログ: .autopilot/ci-fail-1.log");
    expect(p).not.toContain("（必ず直す）");
    expect(p).toContain("ゲートの不合格結果: .autopilot/gate-1-e2e.md");
    expect(p).toContain(".autopilot/review-1-free.md, .autopilot/review-1-coverage.md");
    expect(p).toContain("人間に返すかを自分で判断する");
    expect(p).toContain("失敗を隠す修正はしない");
    expect(p).toContain(".autopilot/needs-human.md");
    expect(all.fix).not.toContain("追加指示");
    expect(all.fix).not.toContain("CI の失敗ログ");
    expect(all.fix).not.toContain("ゲートの不合格結果");
  });

  test("ゲートのプロンプトは 4 つの判定・守ること優先・ファイル非変更・差分読解を含む", () => {
    const p = all.gate;
    expect(p).toContain("あなたはリポジトリのゲート検証担当である");
    expect(p).toContain("ファイルは一切変更しない");
    expect(p).toContain("ゲートの手順書の「守ること」（読み取り専用など）を最優先にする");
    // ゲートは並列に走るので、作業ツリー全体を戻すと別のゲートのファイルを消す。
    expect(p).toContain("自分が作ったファイル");
    expect(p).toContain("作業ツリー全体を戻すコマンドは使わない");
    expect(p).not.toContain("作業ツリーを実行前の状態に戻す");
    expect(p).toContain(prompts.GATE_VERDICT.pass);
    expect(p).toContain(prompts.GATE_VERDICT.fail);
    expect(p).toContain(prompts.GATE_VERDICT.skip);
    expect(p).toContain(prompts.GATE_VERDICT.inconclusive);
    expect(p).toContain("git diff abc123...HEAD");
    expect(p).toContain("PR 番号は #7 である");

    const localGate = prompts.gate({
      name: "e2e",
      sourcePath: ".autopilot/gate-src-e2e.md",
      baseSha: "abc123",
      pr: null,
    });
    expect(localGate).toContain("PR 番号はない（--local で実行中）");
    expect(localGate).toContain("「対象外」と判定する");
  });

  test("要約は PR があるときだけ PR 本文も更新させ、観点ごとの担当・件数・欠けた観点を書かせる", () => {
    expect(prompts.summarize("abc", 7)).toContain("PR #7 の本文");
    expect(prompts.summarize("abc", null)).not.toContain("PR #");
    expect(all.summarize).toContain("観点ごとの担当（CLI・モデル）");
    expect(all.summarize).toContain("観点ごとの must / should の件数");
    expect(all.summarize).toContain("片方の観点しか挙げなかった must");
    expect(all.summarize).toContain("欠けた観点があればその旨を書く");
    expect(all.summarize).toContain("gate-*.md");
    expect(all.summarize).toContain("needs-human.md");
    expect(all.summarize).toContain("ゲートごとの判定と担当（CLI・モデル）");
    expect(all.summarize).toContain("対象外・判定不能もその旨を書く");

    const withMissing = prompts.summarize("abc", null, ["free"]);
    expect(withMissing).toContain("全候補が失敗してレビューが欠けた観点: free");
  });

  test("2 周目以降のレビューは、前回レビューした HEAD からの修正を示す", () => {
    for (const perspective of ["free", "coverage"] as const) {
      const p = prompts.review(perspective, { baseSha: "abc", since: "def" });
      expect(p).toContain("git diff abc...HEAD");
      expect(p).toContain("git diff def..HEAD");
    }
    expect(all.reviewFree).not.toContain("前回のレビューの後の修正");
    expect(all.reviewCoverage).not.toContain("前回のレビューの後の修正");
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

  test("修正は brief.md の仕様を読ませる（--from review / gate では実装の会話が無い）", () => {
    expect(all.fix).toContain(".autopilot/brief.md の仕様を読み");
  });

  test("修正は、変更しないことを失敗と思わせない", () => {
    expect(all.fix).toContain("変更しないことは失敗ではない");
  });
});

describe("reviewHasMust", () => {
  test("must なしの判定なら false", () => {
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
    expect(prompts.reviewHasMust(`前置き\n${prompts.VERDICT.none}（should あり）`)).toBe(true);
    expect(prompts.reviewHasMust(`${prompts.VERDICT.none}（should あり）`)).toBe(true);
  });

  test("前置きの行があっても、最初の「判定:」の行を読む", () => {
    expect(prompts.reviewHasMust(`前置き\n${prompts.VERDICT.none}`)).toBe(false);
    expect(prompts.reviewHasMust(`前置き\n\n**${prompts.VERDICT.must}**`)).toBe(true);
    expect(prompts.reviewHasMust(`前置き\n${prompts.VERDICT.must}\n${prompts.VERDICT.none}`)).toBe(
      true,
    );
  });
});

describe("parseGateVerdict", () => {
  test("4 つの判定を正しく読む", () => {
    expect(prompts.parseGateVerdict(`${prompts.GATE_VERDICT.pass}\n問題なし`)).toBe("pass");
    expect(prompts.parseGateVerdict(`${prompts.GATE_VERDICT.fail}\n壊れている`)).toBe("fail");
    expect(prompts.parseGateVerdict(`${prompts.GATE_VERDICT.skip}\nPreviewなし`)).toBe("skip");
    expect(prompts.parseGateVerdict(`${prompts.GATE_VERDICT.inconclusive}\n500エラー`)).toBe(
      "inconclusive",
    );
  });

  test("Markdown の装飾や前の空行があっても判定を読む", () => {
    expect(prompts.parseGateVerdict(`\n\n**${prompts.GATE_VERDICT.pass}**\n`)).toBe("pass");
    expect(prompts.parseGateVerdict(`# ${prompts.GATE_VERDICT.fail}`)).toBe("fail");
    expect(prompts.parseGateVerdict(`> ${prompts.GATE_VERDICT.skip}`)).toBe("skip");
  });

  test("判定が読めなければ unknown を返す", () => {
    expect(prompts.parseGateVerdict("")).toBe("unknown");
    expect(prompts.parseGateVerdict("合格")).toBe("unknown");
    expect(prompts.parseGateVerdict("判定: 保留")).toBe("unknown");
    expect(prompts.parseGateVerdict("前置き\n判定: 保留")).toBe("unknown");
  });

  test("前置きの行があっても、最初の「判定:」の行を読む", () => {
    expect(prompts.parseGateVerdict(`前置き\n${prompts.GATE_VERDICT.pass}`)).toBe("pass");
    expect(prompts.parseGateVerdict(`前置き\n\n> ${prompts.GATE_VERDICT.inconclusive}`)).toBe(
      "inconclusive",
    );
    expect(
      prompts.parseGateVerdict(
        `前置き\n${prompts.GATE_VERDICT.fail}\n${prompts.GATE_VERDICT.pass}`,
      ),
    ).toBe("fail");
  });
});
