import { describe, expect, test } from "bun:test";
import { type CheckBucket, CI_LIMITS, judgeCi } from "./ci.ts";

const HEAD = "a".repeat(40);
const at = (...checks: CheckBucket[]) => ({ head: HEAD, checks });

describe("judgeCi", () => {
  test("全部通れば pass（skipping は通過扱い）", () => {
    expect(judgeCi(at("pass", "skipping"), HEAD, 0).kind).toBe("pass");
  });

  test("1 件でも失敗・キャンセルなら fail（実行中が残っていても待たない）", () => {
    expect(judgeCi(at("pass", "fail"), HEAD, 0).kind).toBe("fail");
    expect(judgeCi(at("pending", "cancel"), HEAD, 0).kind).toBe("fail");
  });

  test("実行中は上限まで待ち、超えたら stalled", () => {
    expect(judgeCi(at("pass", "pending"), HEAD, 0).kind).toBe("wait");
    expect(judgeCi(at("pass", "pending"), HEAD, CI_LIMITS.pendingLimitMs + 1).kind).toBe("stalled");
  });

  test("PR の HEAD がローカルと違う間は、CI の結果を読まない", () => {
    const old = { head: "b".repeat(40), checks: ["pass"] as CheckBucket[] };
    expect(judgeCi(old, HEAD, 0)).toEqual({ kind: "wait", why: "PR に push が未反映" });
    expect(judgeCi(old, HEAD, CI_LIMITS.pushGraceMs + 1).kind).toBe("unpushed");
  });

  test("CI が見えない間は登録を待ち、猶予を過ぎたら CI 無しとみなす", () => {
    const none = at();
    expect(judgeCi(none, HEAD, 0)).toEqual({ kind: "wait", why: "CI が未登録" });
    expect(judgeCi(none, HEAD, CI_LIMITS.noChecksGraceMs + 1).kind).toBe("none");
  });

  test("GitHub を読めない間は待ち、上限を超えたら stalled", () => {
    expect(judgeCi(null, HEAD, 0).kind).toBe("wait");
    expect(judgeCi(null, HEAD, CI_LIMITS.pendingLimitMs + 1).kind).toBe("stalled");
  });

  test("push 未反映の判定は CI の結果より先に行う", () => {
    expect(judgeCi({ head: "old", checks: ["fail"] }, HEAD, 0).kind).toBe("wait");
  });
});
