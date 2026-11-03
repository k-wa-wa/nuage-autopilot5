/**
 * CI の判定。判定はこの関数だけが行い、待ち方（ポーリング）は pipeline.ts が持つ。
 *
 * GitHub の状態は push の直後に揃わないので、「今見えている状態」をそのまま信じない。
 * - PR の HEAD がローカルと違う間は、古いコミットの結果なので読まない。
 * - CI が 1 件も見えない間は、登録待ちの可能性があるので少し待つ。
 */

export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface PrSnapshot {
  /** PR の HEAD のコミット。 */
  head: string;
  /** CI の結果。CI が 1 件も登録されていなければ空。 */
  checks: CheckBucket[];
}

export const CI_LIMITS = {
  /** push が PR に反映されるまで待つ時間。過ぎたら push されていないとみなす。 */
  pushGraceMs: 5 * 60_000,
  /** CI が登録されるまで待つ時間。過ぎたら CI の無いリポジトリとみなす。 */
  noChecksGraceMs: 3 * 60_000,
  /** CI の完了を待つ時間。過ぎたら人間に戻す。 */
  pendingLimitMs: 60 * 60_000,
};

export type CiVerdict =
  | { kind: "wait"; why: string }
  | { kind: "pass" }
  | { kind: "fail" }
  | { kind: "none" }
  | { kind: "unpushed" }
  | { kind: "stalled" };

/**
 * @param snap GitHub から読んだ状態。読めなかったときは null
 * @param localHead ローカルの HEAD
 * @param elapsedMs 待ち始めてからの経過時間
 */
export function judgeCi(
  snap: PrSnapshot | null,
  localHead: string,
  elapsedMs: number,
  limits = CI_LIMITS,
): CiVerdict {
  if (snap === null) {
    return elapsedMs > limits.pendingLimitMs
      ? { kind: "stalled" }
      : { kind: "wait", why: "GitHub を読めない" };
  }
  if (snap.head !== localHead) {
    return elapsedMs > limits.pushGraceMs
      ? { kind: "unpushed" }
      : { kind: "wait", why: "PR に push が未反映" };
  }
  if (snap.checks.length === 0) {
    return elapsedMs > limits.noChecksGraceMs
      ? { kind: "none" }
      : { kind: "wait", why: "CI が未登録" };
  }
  if (snap.checks.some((c) => c === "fail" || c === "cancel")) return { kind: "fail" };
  if (snap.checks.includes("pending")) {
    return elapsedMs > limits.pendingLimitMs
      ? { kind: "stalled" }
      : { kind: "wait", why: "CI 実行中" };
  }
  return { kind: "pass" };
}
