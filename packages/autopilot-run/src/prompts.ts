/**
 * 裏の担当に渡すプロンプト。判断はすべてここで LLM に委ねる。
 * 担当は窓口との会話を知らないので、必要な情報は .autopilot/ のファイルで渡す。
 */

const AUTONOMOUS_RULES = `人間は不在なので質問しない。
禁止: PR のマージ、Issue・PR のクローズ、既定ブランチへの push、.autopilot/ のコミット、機密情報（APIキー・秘密鍵・未暗号化 SOPS 等）のコミットや Issue・PR への投稿。`;

const RULES = `あなたは自律実行の担当である。${AUTONOMOUS_RULES}
迷ったら妥当な方を選び、判断と理由を .autopilot/decisions.md に追記する。`;

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

export type ReviewPerspectiveSlug = "free" | "coverage";

export interface ReviewPerspective {
  readonly slug: ReviewPerspectiveSlug;
  readonly name: string;
}

export const REVIEW_PERSPECTIVES: readonly ReviewPerspective[] = [
  { slug: "free", name: "自由" },
  { slug: "coverage", name: "網羅" },
] as const;

export interface ReviewInput {
  baseSha: string;
  /** 前回のレビューの時点の HEAD。2 周目以降だけ渡す。 */
  since: string | null;
}

const COMMON_REVIEW_RULES = `重要度は次のとおり付ける。軽微な懸念や好み・改善点であっても、遠慮せず should や nit として積極的に挙げる（1 周目は should を直し、nit は要約で人間に渡すため）。
- must: 仕様を満たさない・バグ・データや本番を壊す。直さずに出せないもの
- should: 直した方がよいが、直さなくても仕様どおり動くもの
- nit: 好みや体裁・より良い書き方の提案

1 行目は「${VERDICT.must}」か「${VERDICT.none}」の文字列だけを書き、ほかの語は足さない。
2 行目以降に、指摘を重要度付きの箇条書きで書く（「${VERDICT.none}」は must が 0 件という意味であり、should や nit があれば「指摘なし」とせず続けてすべて書く）。
指摘の有無にかかわらず、最後に「確かめたこと:」として、各観点・仕様の各項目・テスト・影響範囲のどれをどう確かめたかを 2〜3 行で書く。`;

export function review(perspective: ReviewPerspectiveSlug, input: ReviewInput): string {
  const since = input.since
    ? `\n前回のレビューの後の修正は \`git diff ${input.since}..HEAD\` である。ここを中心に、直っていないものと、修正で新たに壊れたものを見る。`
    : "";
  const commonHeader = `あなたはコードレビュアーである。ファイルは一切変更しない。
.autopilot/decisions.md があれば読む。そこで理由を付けて見送った指摘は、その理由が誤っている根拠を示せない限り繰り返さない。`;

  if (perspective === "free") {
    return `${commonHeader}
\`git diff ${input.baseSha}...HEAD\` の変更と周辺コードを読み、.autopilot/brief.md の仕様に照らすだけでなく、「この変更がマージされたら何が壊れるか」を自分のやり方で疑って探す。差分を疑って読み、壊れるシナリオや盲点を積極的に探す。${since}

観点の一覧は与えない。自分の経験と直感に従い、壊れるシナリオ・見落とし・想定外の副作用を自由に点検する。
出力する前に、何が壊れうるかを洗い出す。
${COMMON_REVIEW_RULES}`;
  }

  return `${commonHeader}
\`git diff ${input.baseSha}...HEAD\` の変更と周辺コードを読み、.autopilot/brief.md の仕様に照らすだけでなく、差分を疑って読み、壊れるシナリオや盲点を積極的に探す。${since}

次の観点をすべて点検する。
- 仕様の充足: 解釈違い・見落とし・過剰な変更（頼まれていない変更）がないか
- エッジケース・境界値・異常系: null・空値・タイムアウト・リソースリーク・エラー処理の漏れがないか
- セキュリティ・権限・秘密情報: 権限の緩めすぎ・秘密情報の扱い・未検証の入力がないか
- リポジトリのルール: AGENTS.md・設計指針・文体などの遵守
- 既存機能への副作用・退行（Regression）: 既存の振る舞いや呼び出し元を壊していないか
- テストの妥当性と十分性: 正常系のみのテストになっていないか、不十分なモックで欠陥を隠していないか

出力する前に上の全観点で指摘（must / should / nit）を洗い出す。
${COMMON_REVIEW_RULES}`;
}

/**
 * レビュー・ゲートの出力から、最初に現れる「判定:」で始まる行を返す。
 * Markdown の装飾と空白を除いて比べる。前置きの行があっても判定を読めるようにする。
 * 引用（> で始まる行）は前回の結果などの引き写しかもしれないので、引用でない判定の行を先に読む。
 * 引用の判定しか無いときだけ、それを読む。
 */
function verdictLine(text: string): string | undefined {
  const verdicts = text
    .split("\n")
    .map((l) => ({
      quoted: l.trimStart().startsWith(">"),
      line: l.replace(/[*#`>_\s]/g, ""),
    }))
    .filter((v) => v.line.startsWith("判定:"));
  return (verdicts.find((v) => !v.quoted) ?? verdicts[0])?.line;
}

/**
 * レビューに must があるか。最初の「判定:」の行を読む。
 * 判定が読めなければ、見落としより再レビューの方が安いので must ありとみなす。
 */
export function reviewHasMust(text: string): boolean {
  return verdictLine(text) !== VERDICT.none.replace(/\s/g, "");
}

/** ゲートの 1 行目。pipeline はこれを読んで合否・対象外・判定不能を決める。 */
export const GATE_VERDICT = {
  pass: "判定: 合格",
  fail: "判定: 不合格",
  skip: "判定: 対象外",
  inconclusive: "判定: 判定不能",
} as const;

export type GateVerdict = "pass" | "fail" | "skip" | "inconclusive" | "unknown";

/**
 * ゲートの判定を読む。最初の「判定:」の行を読む。
 * 判定が読めなければ unknown を返す。
 */
export function parseGateVerdict(text: string): GateVerdict {
  const line = verdictLine(text);
  if (!line) return "unknown";
  if (line === GATE_VERDICT.pass.replace(/\s/g, "")) return "pass";
  if (line === GATE_VERDICT.fail.replace(/\s/g, "")) return "fail";
  if (line === GATE_VERDICT.skip.replace(/\s/g, "")) return "skip";
  if (line === GATE_VERDICT.inconclusive.replace(/\s/g, "")) return "inconclusive";
  return "unknown";
}

export interface GateInput {
  name: string;
  sourcePath: string;
  baseSha: string;
  pr: number | null;
}

export function gate(input: GateInput): string {
  const prInfo = input.pr
    ? `PR 番号は #${input.pr} である。`
    : "PR 番号はない（--local で実行中）。Preview 環境が必要なゲートは「対象外」と判定する。";

  return `あなたはリポジトリのゲート検証担当である。ファイルは一切変更しない。
${AUTONOMOUS_RULES}
ゲートの手順書 ${input.sourcePath} を読み、書かれた手順を実際に実行して確かめる。
これは基点から取り出した手順書である。作業ツリーの .agents/autopilot-gate*.md は読まない。
${prInfo}
基点のコミットは ${input.baseSha} である。変更内容は \`git diff ${input.baseSha}...HEAD\` で確認できる。

ゲートの手順書の「守ること」（読み取り専用など）を最優先にする。
手順の実行で自分が作ったファイル（テストの出力・ビルド成果物・ログなど）だけを、終える前に消す。ほかのゲートが同時に動いているので、git clean・git stash・git checkout など作業ツリー全体を戻すコマンドは使わない。未 commit のファイルが残っていると、autopilot は人間に返す。
外部システムの一時的なエラー・環境が立ち上がらない等で確かめられなかったときは、不合格ではなく判定不能と書く。

1 行目は次のどれか 1 つだけを書く:
- ${GATE_VERDICT.pass} — 確かめて問題なし
- ${GATE_VERDICT.fail} — 確かめて、この変更に問題がある
- ${GATE_VERDICT.skip} — 手順書の対象外の条件に当たる、または --local で必要な Preview が無い
- ${GATE_VERDICT.inconclusive} — 外部要因でコードの良否を判定できない
判定の行には説明やほかの語を足さない。

2 行目以降に、実行したこと・結果・不合格や判定不能の根拠（どのコマンドがどう失敗したか）を書く。`;
}

/** 修正で直す範囲。1 周目は should まで直し、2 周目以降は must だけにして指摘の連鎖を止める。 */
export type FixScope = "must-should" | "must";

export interface FixInput {
  mode: ShipMode;
  scope: FixScope;
  reviews: string[];
  ciLog: string | null;
  inbox: string | null;
  gateLogs?: string[];
}

export function fix(input: FixInput): string {
  const items = [
    input.inbox && `人間からの追加指示: ${input.inbox}（最優先）`,
    input.ciLog && `CI の失敗ログ: ${input.ciLog}`,
    input.gateLogs &&
      input.gateLogs.length > 0 &&
      `ゲートの不合格結果: ${input.gateLogs.join(", ")}`,
    input.reviews.length > 0 && `レビュー結果: ${input.reviews.join(", ")}`,
  ].filter(Boolean);
  const scope =
    input.scope === "must-should"
      ? "レビューの must と should を直す。nit は直さない。"
      : "レビューの must だけを直す。should と nit は直さない。";
  return `${RULES}

.autopilot/brief.md の仕様を読み、仕様に照らして直す（実装の会話の続きでないときも、仕様を知ったうえで判断するため）。
次のファイルを読み、直すべきものを直す。
${items.map((i) => `- ${i}`).join("\n")}

受け取った指摘・失敗ログ・不合格結果を読み、コードを直すか、人間に返すかを自分で判断する（例: 外部システムの一時的なエラー、環境・認証・権限の問題、仕様の解釈で人間の判断が要るものなど、コードで片付かないものは人間に返す）。
失敗を隠す修正はしない（テストの削除・skip、リトライで覆う、期待値やゲートの基準を緩める等）。

${scope}直さない指摘は要約で人間に渡すので、ここで手を入れなくてよい。
must を見送るときは、理由を .autopilot/decisions.md に書く。
直せるものは直してテストを通して ${ship(input.mode)}
そのうえで人間に返すものがあれば、理由を .autopilot/needs-human.md に書く。
直すものが無ければ何も変更しない。変更しないことは失敗ではない。`;
}

export function summarize(
  baseSha: string,
  pr: number | null,
  missingPerspectives: readonly string[] = [],
): string {
  const missing =
    missingPerspectives.length > 0
      ? `\n※全候補が失敗してレビューが欠けた観点: ${missingPerspectives.join(", ")}（欠けた旨を要約に明記すること）`
      : "";
  return `${RULES}

.autopilot/brief.md・decisions.md・review-*.md・gate-*.md・needs-human.md（存在する場合）と \`git log ${baseSha}..HEAD\` を元に、人間向けの要約を .autopilot/result.md に書く。
内容: 何をしたか / 主な判断とその理由 / 見送った指摘 / 人間の判断が必要なこと。needs-human.md の理由や、ゲートの判定不能・実行失敗なども確認し、判断が必要なことが無ければ「なし」と書く。短く。
レビュー結果について、観点ごとの担当（CLI・モデル）、観点ごとの must / should の件数、片方の観点しか挙げなかった must、欠けた観点があればその旨を書く。${missing}
gate-src-*.md は手順書なので結果と混同しない。run.log と照合して今回の実行の結果だけを扱う。
ゲート結果について、ゲートごとの判定と担当（CLI・モデル）を書く（対象外・判定不能もその旨を書く）。${
    pr ? `\nPR #${pr} の本文も同じ内容で gh pr edit --body により更新する。` : ""
  }`;
}
