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

export function review(baseSha: string): string {
  return `あなたはコードレビュアーである。ファイルは一切変更しない。
\`git diff ${baseSha}...HEAD\` の変更を、.autopilot/brief.md の仕様に照らしてレビューする。
指摘は重要度（must / should / nit）を付けて箇条書きで出力する。問題が無ければ 1 行目を「指摘なし」とする。
指摘の有無にかかわらず、最後に「確かめたこと:」として、仕様の各項目・テスト・影響範囲のどれをどう確かめたかを 2〜3 行で書く。`;
}

export interface FixInput {
  mode: ShipMode;
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
  return `${RULES}

次のファイルを読み、直すべきものを直す。
${items.map((i) => `- ${i}`).join("\n")}

レビューの must は原則採用する。見送る指摘は理由を .autopilot/decisions.md に書く。
直したらテストを通して ${ship(input.mode)}
直すものが無ければ何も変更しない。`;
}

export function summarize(baseSha: string, pr: number | null): string {
  return `${RULES}

.autopilot/brief.md・decisions.md・review-*.md と \`git log ${baseSha}..HEAD\` を元に、人間向けの要約を .autopilot/result.md に書く。
内容: 何をしたか / 主な判断とその理由 / 見送った指摘 / 人間の判断が必要なこと（無ければ「なし」）。短く。${
    pr ? `\nPR #${pr} の本文も同じ内容で gh pr edit --body により更新する。` : ""
  }`;
}
