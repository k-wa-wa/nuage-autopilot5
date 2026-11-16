import { describe, expect, test } from "bun:test";
import * as prompts from "./prompts.ts";
import { kindOf, MARKERS } from "./testing/helpers.ts";

const all = {
  spec: prompts.spec({
    requestPath: ".autopilot/request.md",
    specPath: ".autopilot/spec.md",
    prevSpecPath: null,
  }),
  specReview: prompts.specReview({
    specPath: ".autopilot/spec.md",
    requestPath: ".autopilot/request.md",
  }),
  implement: prompts.implement("pr", ".autopilot/request.md"),
  review: prompts.review({
    baseSha: "abc123",
    since: null,
    specPath: ".autopilot/request.md",
  }),
  gate: prompts.gate({
    name: "e2e",
    sourcePath: ".autopilot/gate-src-e2e.md",
    baseSha: "abc123",
    pr: 7,
  }),
  fix: prompts.fix({
    mode: "pr",
    scope: "must-should",
    reviews: [".autopilot/review-1-claude.md"],
    ciLog: null,
    inbox: null,
    specPath: ".autopilot/request.md",
  }),
  summarize: prompts.summarize("abc123", 7, "done", ".autopilot/request.md"),
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
    expect(prompts.implement("pr", ".autopilot/request.md")).toContain("push");
    expect(prompts.implement("pr", ".autopilot/request.md")).toContain("gh pr create");
    expect(prompts.implement("pr", ".autopilot/request.md")).toContain("Draft にはしない");
  });

  test("--local は push も PR 作成もさせない", () => {
    for (const p of [
      prompts.implement("local", ".autopilot/request.md"),
      prompts.fix({
        mode: "local",
        scope: "must-should",
        reviews: [],
        ciLog: null,
        inbox: null,
        specPath: ".autopilot/request.md",
      }),
    ]) {
      expect(p).toContain("push と PR 作成はしない");
      expect(p).not.toContain("gh pr create");
    }
  });

  test("仕様検討プロンプトは request.md とコードを読み spec.md を書かせ、合意仕様を変更させない", () => {
    const p = all.spec;
    expect(p).toContain("あなたは仕様検討の担当である");
    expect(p).toContain("コードは一切変更しない");
    expect(p).toContain(".autopilot/request.md とコードを読み、.autopilot/spec.md を書く");
    expect(p).toContain("内容: 目的 / 仕様 / 受け入れ条件 / 設計判断とその理由");
    expect(p).toContain(".autopilot/request.md の「合意した仕様」は変えない");
    expect(p).toContain(".autopilot/needs-human.md に書く（選択肢と推奨を添える）");
    expect(p).toContain(".autopilot/decisions.md に追記する");
    expect(p).not.toContain("前回の仕様案");

    const withPrev = prompts.spec({
      requestPath: ".autopilot/request.md",
      specPath: ".autopilot/spec.md",
      prevSpecPath: ".autopilot/spec-prev.md",
    });
    expect(withPrev).toContain(
      "前回の仕様案 .autopilot/spec-prev.md があれば下書きとして参考にしてよい",
    );
  });

  test("仕様レビュープロンプトは 4 観点・判定行・ファイル非変更を含む", () => {
    const p = all.specReview;
    expect(p).toContain("あなたは仕様レビュアーである");
    expect(p).toContain("ファイルは一切変更しない");
    expect(p).toContain(".autopilot/spec.md を .autopilot/request.md とコードに照らして見る");
    expect(p).toContain("依頼とのずれ");
    expect(p).toContain("受け入れ条件");
    expect(p).toContain("設計の約束との衝突");
    expect(p).toContain("頼まれていない変更");
    expect(p).toContain(`「${prompts.VERDICT.must}」か「${prompts.VERDICT.none}」`);
    expect(p).toContain("ほかの語は足さない");
  });

  test("仕様修正プロンプトは must と should を直させ、合意仕様を変更させない", () => {
    const p = prompts.specFix({
      specPath: ".autopilot/spec.md",
      requestPath: ".autopilot/request.md",
      reviews: [".autopilot/spec-review-1-claude.md"],
    });
    expect(p).toContain("あなたは仕様検討の担当である");
    expect(p).toContain("コードは一切変更しない");
    expect(p).toContain(".autopilot/spec.md の must と should を直す。nit は直さなくてよい");
    expect(p).toContain(".autopilot/spec-review-1-claude.md");
    expect(p).toContain(".autopilot/request.md の「合意した仕様」は変えない");
    expect(p).toContain(".autopilot/needs-human.md に書く（選択肢と推奨を添える）");
  });

  test("レビュープロンプトは 6 観点点検・ファイル非変更・1行目判定・確かめたこと・decisions.md を含む", () => {
    const p = all.review;
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
      expect(p).toContain(aspect);
    }
  });

  test("修正には、渡されたものだけを並べる（優先度つき）", () => {
    const p = prompts.fix({
      mode: "pr",
      scope: "must-should",
      reviews: [".autopilot/review-1-claude.md"],
      ciLog: ".autopilot/ci-fail-1.log",
      inbox: ".autopilot/inbox-1.md",
      gateLogs: [".autopilot/gate-1-e2e.md"],
      specPath: ".autopilot/request.md",
    });
    expect(p).toContain("人間からの追加指示: .autopilot/inbox-1.md（最優先）");
    expect(p).toContain("CI の失敗ログ: .autopilot/ci-fail-1.log");
    expect(p).toContain("ゲートの不合格結果: .autopilot/gate-1-e2e.md");
    expect(p).toContain(".autopilot/review-1-claude.md");
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

  test("要約は PR があるときだけ PR 本文も更新させ、担当・件数・主な指摘を書かせる", () => {
    expect(prompts.summarize("abc", 7, "done", ".autopilot/request.md")).toContain("PR #7 の本文");
    expect(prompts.summarize("abc", null, "done", ".autopilot/request.md")).not.toContain("PR #");
    expect(all.summarize).toContain("担当（CLI・モデル）");
    expect(all.summarize).toContain("must / should の件数");
    expect(all.summarize).toContain("主な指摘");
    expect(all.summarize).not.toContain("観点ごとの担当");
    expect(all.summarize).not.toContain("欠けた観点");
    expect(all.summarize).toContain("gate-*.md");
    expect(all.summarize).toContain("needs-human.md");
    expect(all.summarize).toContain("ゲートごとの判定と担当（CLI・モデル）");
    expect(all.summarize).toContain("対象外・判定不能もその旨を書く");
  });

  test("要約に終わり方と理由を渡し、needs-human の理由を人間に渡させる", () => {
    const p = prompts.summarize("abc", 7, "needs-human: CI が終わらない", ".autopilot/request.md");
    expect(p).toContain("今回の結果は「needs-human: CI が終わらない」");
    expect(p).toContain(
      "needs-human ならその理由を「人間の判断が必要なこと」に必ず書き、選択肢と推奨を添える",
    );
  });

  test("2 周目以降のレビューは、前回レビューした HEAD からの修正を示す", () => {
    const p = prompts.review({ baseSha: "abc", since: "def", specPath: ".autopilot/request.md" });
    expect(p).toContain("git diff abc...HEAD");
    expect(p).toContain("git diff def..HEAD");
    expect(all.review).not.toContain("前回のレビューの後の修正");
  });

  test("修正の範囲: 1 周目は should まで、2 周目以降は must だけ。nit は直させない", () => {
    const base = {
      mode: "pr" as const,
      reviews: [],
      ciLog: null,
      inbox: null,
      specPath: ".autopilot/request.md",
    };
    expect(prompts.fix({ ...base, scope: "must-should" })).toContain(
      "must と should を直す。nit は直さない",
    );
    expect(prompts.fix({ ...base, scope: "must" })).toContain(
      "must だけを直す。should と nit は直さない",
    );
  });

  test("修正は仕様ファイルを読ませる（--from review / gate では実装の会話が無い）", () => {
    expect(all.fix).toContain(".autopilot/request.md の仕様を読み");
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
