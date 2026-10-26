/**
 * 裏の担当に渡すプロンプト。判断はすべてここで LLM に委ねる。
 * 担当は窓口との会話を知らないので、必要な情報は .autopilot/ のファイルで渡す。
 */

const RULES = `あなたは自律実行の担当である。人間は不在なので質問しない。
迷ったら妥当な方を選び、判断と理由を .autopilot/decisions.md に追記する。
禁止: PR のマージ、Issue・PR のクローズ、既定ブランチへの push、.autopilot/ のコミット。`;

export type ShipMode = "pr" | "local";

function ship(mode: ShipMode): string {
  return mode === "pr"
    ? "変更を commit して作業ブランチを push する。PR が無ければ gh pr create で作る（本文に brief の要点、関連 Issue があれば Closes #番号）。Draft にはしない。"
    : "変更は commit まで行う。push と PR 作成はしない。";
}

export function implement(mode: ShipMode): string {
  return `${RULES}

.autopilot/brief.md の仕様を実装し、テストがあれば実行して通す。${ship(mode)}`;
}

/** レビューの 1 行目。修正ループはこれを読んで、再レビューが要るかを決める。 */
export const VERDICT = { must: "判定: must あり", none: "判定: must なし" } as const;

export interface ReviewInput {
  baseSha: string;
  /** 前回のレビューの時点の HEAD。2 周目以降だけ渡す。 */
  since: string | null;
}

export function review(input: ReviewInput): string {
  const since = input.since
    ? `\n前回のレビューの後の修正は \`git diff ${input.since}..HEAD\` である。ここを中心に、直っていないものと、修正で新たに壊れたものを見る。`
    : "";
  return `あなたはコードレビュアーである。ファイルは一切変更しない。
\`git diff ${input.baseSha}...HEAD\` の変更を、.autopilot/brief.md の仕様に照らしてレビューする。${since}
.autopilot/decisions.md があれば読む。そこで理由を付けて見送った指摘は、その理由が誤っている根拠を示せない限り繰り返さない。

重要度は次のとおり付ける。
- must: 仕様を満たさない・バグ・データや本番を壊す。直さずに出せないもの
- should: 直した方がよいが、直さなくても仕様どおり動くもの
- nit: 好みや体裁

1 行目は「${VERDICT.must}」か「${VERDICT.none}」のどちらかだけを書く。続けて指摘を重要度付きの箇条書きで書く。
指摘の有無にかかわらず、最後に「確かめたこと:」として、仕様の各項目・テスト・影響範囲のどれをどう確かめたかを 2〜3 行で書く。`;
}

/**
 * レビューに must があるか。1 行目の判定だけを読む。
 * 判定が読めなければ、見落としより再レビューの方が安いので must ありとみなす。
 */
export function reviewHasMust(text: string): boolean {
  const first = text
    .split("\n")
    .map((l) => l.replace(/[*#`>_\s]/g, ""))
    .find((l) => l !== "");
  return first !== VERDICT.none.replace(/\s/g, "");
}

/** 修正で直す範囲。1 周目は should まで直し、2 周目以降は must だけにして指摘の連鎖を止める。 */
export type FixScope = "must-should" | "must";

export interface FixInput {
  mode: ShipMode;
  scope: FixScope;
  reviews: string[];
  ciLog: string | null;
  inbox: string | null;
}

export function fix(input: FixInput): string {
  const items = [
    input.inbox && `人間からの追加指示: ${input.inbox}（最優先）`,
    input.ciLog && `CI の失敗ログ: ${input.ciLog}（必ず直す）`,
    input.reviews.length > 0 && `レビュー結果: ${input.reviews.join(", ")}`,
  ].filter(Boolean);
  const scope =
    input.scope === "must-should"
      ? "レビューの must と should を直す。nit は直さない。"
      : "レビューの must だけを直す。should と nit は直さない。";
  return `${RULES}

次のファイルを読み、直すべきものを直す。
${items.map((i) => `- ${i}`).join("\n")}

${scope}直さない指摘は要約で人間に渡すので、ここで手を入れなくてよい。
must を見送るときは、理由を .autopilot/decisions.md に書く。
直したらテストを通して ${ship(input.mode)}
直すものが無ければ何も変更しない。変更しないことは失敗ではない。`;
}

export function summarize(baseSha: string, pr: number | null): string {
  return `${RULES}

.autopilot/brief.md・decisions.md・review-*.md と \`git log ${baseSha}..HEAD\` を元に、人間向けの要約を .autopilot/result.md に書く。
内容: 何をしたか / 主な判断とその理由 / 見送った指摘 / 人間の判断が必要なこと（無ければ「なし」）。短く。${
    pr ? `\nPR #${pr} の本文も同じ内容で gh pr edit --body により更新する。` : ""
  }`;
}
