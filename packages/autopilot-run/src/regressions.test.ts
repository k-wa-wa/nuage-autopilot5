import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArgv, classifyFailure } from "./agents.ts";
import { judgeCi } from "./ci.ts";
import { run } from "./exec.ts";
import { findGateFiles, gateNameFromPath, parseChecks, parsePrNumber } from "./github.ts";
import { parseStartOptions } from "./main.ts";
import { reviewFileName, runPipeline } from "./pipeline.ts";
import * as prompts from "./prompts.ts";
import { VERDICT } from "./prompts.ts";
import { State } from "./state.ts";
import {
  assignee,
  CLAUDE_UNAVAILABLE_MESSAGES,
  CODEX_UNAVAILABLE_MESSAGES,
  checks,
  GH_NO_AUTH,
  GH_NO_PR,
  git,
  pipelineConfig,
  pipelineHarness,
  splitUtf8Script,
  tempDir,
  tempRepo,
} from "./testing/helpers.ts";

describe("ゲート読み取りの失敗をゲートなしとして通り抜けさせない", () => {
  test("手順書が読めなければ修正ループを回さず人間へ返し、要約する", async () => {
    const h = pipelineHarness({
      commits: [],
      gates: () => {
        throw new Error("git show failed");
      },
    });
    const outcome = await runPipeline(
      pipelineConfig(assignee("claude"), [assignee("agy")], { from: "gate" }),
      h.deps,
    );
    expect(outcome).toEqual({
      kind: "needs-human",
      reason: "ゲートの手順書を読めない: git show failed",
    });
    expect(h.logs).not.toContain("ゲートなし");
    expect(h.calls.map((c) => c.kind)).toEqual(["summarize"]);
  });
});

/**
 * 実際に踏んだ欠陥の回帰テスト。
 * どれも「型では防げず、動かして初めて分かる」種類のものだった。
 */

describe("agy が --model をプロンプトとして読んだ", () => {
  // agy の -p は直後の引数をプロンプトとして読む。`agy -p --model m PROMPT` は
  // 「-p took "--model" as its prompt」になった。
  test("どのエージェントも -p の直後がプロンプト", () => {
    for (const agent of ["claude", "agy"] as const) {
      expect(buildArgv({ agent, model: "m", effort: "high" }, "PROMPT").slice(-2)).toEqual([
        "-p",
        "PROMPT",
      ]);
    }
  });
});

describe("Claude CLI レビューで実物の利用不能メッセージを判定できなかった", () => {
  test("Claude のセッション・週間・支出・コンテキスト上限を切り替え対象にする", () => {
    for (const stdout of CLAUDE_UNAVAILABLE_MESSAGES) {
      expect(classifyFailure("claude", { code: 1, stdout, stderr: "" })).toBe("unavailable");
    }
  });

  test("Codex のコンテキスト上限・トークン再発行失敗・支出上限を認識する", () => {
    for (const message of CODEX_UNAVAILABLE_MESSAGES) {
      const stdout = JSON.stringify({ type: "turn.failed", error: { message } });
      expect(classifyFailure("codex", { code: 1, stdout, stderr: "" })).toBe("unavailable");
    }
  });

  test("通常の応答内のエラー例・ネスト上限では別 CLI に切り替えない", () => {
    for (const agent of ["agy", "claude"] as const) {
      for (const stdout of [
        "レートリミット実装: 429 Too Many Requests を返す",
        '設定例: "context_length_exceeded" を扱う',
        "Subagent nesting limit reached",
        "429 を返すようにした",
        "exceeded retry limit, last status: 500 Internal Server Error",
        "Reached the step limit for this task",
        "hit the recursion limit",
      ]) {
        expect(classifyFailure(agent, { code: 1, stdout, stderr: "connect ECONNRESET" })).toBe(
          "error",
        );
      }
      // agy の構造化出力でも、正常な本文は診断に使わない。
      expect(
        classifyFailure(agent, {
          code: 1,
          stdout: JSON.stringify({ status: "SUCCESS", response: "Rate limit exceeded" }),
          stderr: "connect ECONNRESET",
        }),
      ).toBe("error");
    }
    expect(
      classifyFailure("codex", {
        code: 1,
        stderr: "",
        stdout: JSON.stringify({
          type: "turn.failed",
          error: { message: "exceeded retry limit, last status: 500 Internal Server Error" },
        }),
      }),
    ).toBe("error");
  });

  test("stderr の接頭辞付き機械コードと API エラーを認識する", () => {
    for (const stderr of [
      "E1112 04:00:00.000 client.go:12] RESOURCE_EXHAUSTED: Quota exceeded for model",
      "Error 429: RESOURCE_EXHAUSTED",
      "rpc error: code = ResourceExhausted desc = quota exceeded",
    ])
      expect(classifyFailure("agy", { code: 1, stdout: "", stderr })).toBe("unavailable");
    for (const stdout of ["API Error: 429 Too Many Requests", "API Error: 401 Unauthorized"]) {
      expect(classifyFailure("claude", { code: 1, stdout, stderr: "" })).toBe("unavailable");
    }
    expect(
      classifyFailure("claude", {
        code: 1,
        stdout: "API Error: 500 Internal Server Error",
        stderr: "",
      }),
    ).toBe("error");
  });

  test("Codex のリトライ終了でも、429 は上限、500 は通信障害として区別する", () => {
    for (const [status, expected] of [
      ["429 Too Many Requests", "unavailable"],
      ["500 Internal Server Error", "error"],
    ] as const) {
      const stdout = JSON.stringify({
        type: "turn.failed",
        error: {
          message: `exceeded retry limit, last status: ${status}`,
        },
      });
      expect(classifyFailure("codex", { code: 1, stdout, stderr: "" })).toBe(expected);
    }
    expect(
      classifyFailure("agy", {
        code: 1,
        stdout: "exceeded retry limit, last status: 429 Too Many Requests",
        stderr: "connect ECONNRESET",
      }),
    ).toBe("error");
  });
});

describe("レビュー本文の UTF-8 が stdout / stderr のチャンクの境目で壊れた", () => {
  test("多バイト文字の途中で分かれた出力を文字化けさせずに返す", async () => {
    const dir = tempDir();
    try {
      const out = join(dir.path, "out.log");
      const log = join(dir.path, "run.log");
      const text = "判定: must なし\n確かめたこと: 日本語 🌧️\n";
      const result = await run([process.execPath, "-e", splitUtf8Script(out, log, text)], {
        cwd: dir.path,
        stdoutPath: out,
        logPath: log,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(text);
      expect(result.stderr).toBe(text);
      expect(readFileSync(out, "utf8")).toBe(text);
      expect(readFileSync(log, "utf8")).toBe(text);
    } finally {
      dir.cleanup();
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
  test("ファイル名は観点で決まり、同じエージェントでも上書きされない", () => {
    expect(reviewFileName("free", 1)).not.toBe(reviewFileName("coverage", 1));
  });
});

describe("レビューが毎回「指摘なし」の 1 行だけで、確かめた範囲が分からなかった（pechka #75 の試運転）", () => {
  // プロンプトが「問題が無ければ『指摘なし』とだけ出力する」だったので、浅いレビューと見分けられなかった。
  test("指摘が無くても、確かめたことを書かせる", () => {
    const p = prompts.review("coverage", { baseSha: "abc", since: null });
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
      "exhausted",
      "available",
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
    expect(h.calls.filter((c) => c.kind === "review")).toHaveLength(2);
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
    expect(h.calls.filter((c) => c.kind === "review")).toHaveLength(2);
  });

  test("修正担当が見送った指摘を、レビュー担当が毎周繰り返した", () => {
    // レビュー担当は decisions.md を読んでいなかった。
    expect(prompts.review("coverage", { baseSha: "abc", since: "def" })).toContain(
      ".autopilot/decisions.md",
    );
  });
});

describe("レビューが仕様受入検査に偏り、ほぼ毎回「must なし / 指摘なし」で修正ループが形骸化した（nuage-cluster、nuage-dr、nuage-usage-ledger）", () => {
  // 1 行目に「判定: must なし」と書いた確証バイアスで、should や nit まで「指摘なし」と省略されていた。
  test("1 行目が must なしでも should / nit を省略せず出させる", () => {
    const p = prompts.review("coverage", { baseSha: "abc", since: null });
    expect(p).toContain("should や nit があれば「指摘なし」とせず続けてすべて書く");
  });
});

describe("切り替え先に別エージェントの会話 ID を渡さない", () => {
  test("実装に成功した担当のモデルを維持し、修正の上限エラーで別 CLI に再開させない", async () => {
    const writer = {
      name: "agy",
      chain: [
        { agent: "agy" as const, model: "a1" },
        { agent: "codex" as const, model: "x1" },
        { agent: "claude" as const, model: "c1" },
      ],
    };
    const h = pipelineHarness({
      commits: [true],
      failAgent: (inv, kind) => (kind === "implement" && inv.agent === "agy") || kind === "fix",
    });
    expect((await runPipeline(pipelineConfig(writer, [assignee("claude")]), h.deps)).kind).toBe(
      "failed",
    );
    const fixes = h.calls.filter((c) => c.kind === "fix");
    expect(fixes.map((c) => c.inv)).toEqual([{ agent: "codex", model: "x1" }]);
    expect(fixes[0]!.session).toEqual({ kind: "resume", id: "conv1" });
  });
});

describe("ゲート実行中の追加指示を取りこぼし、追加仕様まで未レビューになった", () => {
  const cfg = pipelineConfig(assignee("claude"), [assignee("agy")]);

  test("持ち越したゲート不合格と追加指示を一緒に直したら再レビューする", async () => {
    const h = pipelineHarness({
      commits: [true, false, true],
      review: () => VERDICT.none,
      gates: [{ name: "e2e" }],
      gate: (round) => (round === 1 ? prompts.GATE_VERDICT.fail : prompts.GATE_VERDICT.pass),
    });
    const run = h.deps.runAgent;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const result = await run(inv, prompt, opts);
      if (opts?.output === "gate-1-e2e.md") h.deps.state.write("inbox.md", "追加仕様");
      return result;
    };
    expect(await runPipeline(cfg, h.deps)).toEqual({ kind: "done" });
    const fixes = h.calls.filter((c) => c.kind === "fix");
    expect(fixes[1]?.prompt).toContain(".autopilot/gate-1-e2e.md");
    expect(fixes[1]?.prompt).toContain(".autopilot/inbox-2.md");
    expect(h.calls.filter((c) => c.output?.startsWith("review-3-")).length).toBe(2);
  });

  test.each(["gate", "implement"] as const)(
    "%s からのゲート合格中に届いた指示を処理してから完了する",
    async (from) => {
      const h = pipelineHarness({
        commits: from === "gate" ? [true] : [true, false, true],
        inbox: from === "implement",
        review: () => VERDICT.none,
        gates: [{ name: "e2e" }],
      });
      const run = h.deps.runAgent;
      h.deps.runAgent = async (inv, prompt, opts) => {
        const result = await run(inv, prompt, opts);
        if (opts?.output === "gate-1-e2e.md") h.deps.state.write("inbox.md", "ゲート中の追加仕様");
        return result;
      };
      expect(await runPipeline({ ...cfg, from }, h.deps)).toEqual({ kind: "done" });
      expect(
        h.calls.some((c) => c.kind === "fix" && c.prompt.includes("人間からの追加指示:")),
      ).toBe(true);
      expect(h.deps.state.read("inbox.md")).toBeNull();
      if (from === "implement") expect(h.deps.state.read("inbox-1.md")).toBe("追加指示");
      expect(
        h.calls.filter((c) => c.output?.startsWith(`review-${from === "gate" ? 2 : 3}-`)),
      ).toHaveLength(2);
      expect(h.calls.at(-1)?.kind).toBe("summarize");
    },
  );

  test("最終周のゲート中に届いた指示は未処理のまま done にしない", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: () => VERDICT.none,
      gates: [{ name: "e2e" }],
    });
    const run = h.deps.runAgent;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const result = await run(inv, prompt, opts);
      if (opts?.output === "gate-1-e2e.md") h.deps.state.write("inbox.md", "追加仕様");
      return result;
    };
    const result = await runPipeline({ ...cfg, maxRounds: 1 }, h.deps);
    expect(result).toEqual({
      kind: "needs-human",
      reason: "修正ループが上限（1 回）に達した。人間の追加指示が未処理で残っている",
    });
    expect(h.deps.state.read("inbox.md")).toBe("追加仕様");
  });

  test("最終周で持ち越したゲート不合格は未修正であることを理由に残す", async () => {
    const h = pipelineHarness({
      commits: [true, false],
      review: () => VERDICT.none,
      gates: [{ name: "e2e" }],
      gate: () => prompts.GATE_VERDICT.fail,
    });
    expect(await runPipeline({ ...cfg, maxRounds: 1 }, h.deps)).toEqual({
      kind: "needs-human",
      reason: "修正ループが上限（1 回）に達した。ゲートの不合格が未修正で残っている",
    });
  });
});

describe("ゲート合格後の追加指示で HEAD が変わらないと、同じ HEAD でゲートを走らせ直した", () => {
  // 重いゲートを二度走らせ、2 回目が不安定だと合格済みの HEAD が needs-human になり、1 回目の結果も上書きされた。
  const cfg = pipelineConfig(assignee("claude"), [assignee("agy")]);

  function deliverInboxDuringGate(h: ReturnType<typeof pipelineHarness>, output: string) {
    const run = h.deps.runAgent;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const result = await run(inv, prompt, opts);
      if (opts?.output === output) h.deps.state.write("inbox.md", "ゲート中の追加指示");
      return result;
    };
  }

  test("合格済みの HEAD ではゲートを走らせ直さずに done にする", async () => {
    const h = pipelineHarness({
      commits: [],
      review: () => VERDICT.none,
      gates: [{ name: "e2e" }],
      gate: (round) =>
        round === 1 ? prompts.GATE_VERDICT.pass : prompts.GATE_VERDICT.inconclusive,
    });
    deliverInboxDuringGate(h, "gate-1-e2e.md");
    expect(await runPipeline({ ...cfg, from: "gate" }, h.deps)).toEqual({ kind: "done" });
    expect(h.calls.filter((c) => c.kind === "fix")).toHaveLength(1);
    expect(h.calls.filter((c) => c.output?.startsWith("gate-"))).toHaveLength(1);
    expect(h.logs).toContain("この HEAD はゲートに合格済みなので、ゲートを走らせ直さない");
  });

  test("合格済みの HEAD でも、未処理の追加指示が残れば次の周へ回す", async () => {
    const h = pipelineHarness({
      commits: [],
      review: () => VERDICT.none,
      gates: [{ name: "e2e" }],
    });
    const run = h.deps.runAgent;
    let fixes = 0;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const result = await run(inv, prompt, opts);
      if (opts?.output === "gate-1-e2e.md") h.deps.state.write("inbox.md", "1 通目");
      if (prompt.includes("人間からの追加指示:") && ++fixes === 1) {
        h.deps.state.write("inbox.md", "2 通目");
      }
      return result;
    };
    expect(await runPipeline({ ...cfg, from: "gate" }, h.deps)).toEqual({ kind: "done" });
    const fixPrompts = h.calls.filter((c) => c.kind === "fix").map((c) => c.prompt);
    expect(fixPrompts).toHaveLength(2);
    expect(fixPrompts[1]).toContain(".autopilot/inbox-2.md");
    expect(h.calls.filter((c) => c.output?.startsWith("gate-"))).toHaveLength(1);
  });

  test("ゲート不合格と追加指示が同時に来て HEAD が変わらなければ needs-human", async () => {
    const h = pipelineHarness({
      commits: [],
      review: () => VERDICT.none,
      gates: [{ name: "e2e" }],
      gate: () => prompts.GATE_VERDICT.fail,
    });
    deliverInboxDuringGate(h, "gate-1-e2e.md");
    expect(await runPipeline({ ...cfg, from: "gate" }, h.deps)).toEqual({
      kind: "needs-human",
      reason: "ゲートの不合格を直せなかった",
    });
    const fix = h.calls.find((c) => c.kind === "fix");
    expect(fix?.prompt).toContain(".autopilot/gate-1-e2e.md");
    expect(fix?.prompt).toContain(".autopilot/inbox-1.md");
  });
});

describe("修正担当が commit せずに変更を残すと、未 commit の作業ツリーがゲートに合格して done になった", () => {
  test("HEAD が変わらず作業ツリーだけ変わったら、ゲートへ進まず needs-human", async () => {
    const h = pipelineHarness({
      commits: [],
      review: () => VERDICT.none,
      gates: [{ name: "e2e" }],
      dirtyOnSuccess: (_inv, kind) => kind === "fix",
    });
    const cfg = pipelineConfig(assignee("claude"), [assignee("agy")]);
    const run = h.deps.runAgent;
    h.deps.runAgent = async (inv, prompt, opts) => {
      const result = await run(inv, prompt, opts);
      if (opts?.output === "gate-1-e2e.md") h.deps.state.write("inbox.md", "追加指示");
      return result;
    };
    expect(await runPipeline({ ...cfg, from: "gate" }, h.deps)).toEqual({
      kind: "needs-human",
      reason: "修正担当が変更を commit せずに残した",
    });
    expect(h.calls.filter((c) => c.output?.startsWith("gate-"))).toHaveLength(1);
  });
});

describe("長いゲート名の URL 符号化で保存先が ENAMETOOLONG になった", () => {
  test("日本語・ASCII の長い名前と短縮後の衝突でも全手順書・結果を保存できる", async () => {
    const repo = tempRepo();
    try {
      const paths = [
        `.agents/autopilot-gate-${"日".repeat(30)}.md`,
        `.agents/autopilot-gate-${"日".repeat(29)}本.md`,
        `.agents/autopilot-gate-${"x".repeat(200)}.md`,
      ];
      paths.push(`.agents/autopilot-gate-${gateNameFromPath(paths[2]!)}.md`);
      mkdirSync(join(repo.work, ".agents"));
      paths.forEach((path, i) => {
        writeFileSync(join(repo.work, path), `手順 ${i}`);
      });
      git(repo.work, "add", ".agents");
      git(repo.work, "commit", "-qm", "long gate names");
      const gates = await findGateFiles(repo.work, "HEAD");
      expect(gates).toHaveLength(paths.length);
      expect(gates.some((g) => g.name.endsWith("-2"))).toBe(true);
      expect(new Set(gates.map((g) => g.name)).size).toBe(paths.length);
      expect(await findGateFiles(repo.work, "HEAD")).toEqual(gates);
      const state = new State(repo.work);
      for (const gate of gates) {
        for (const name of [`gate-src-${gate.name}.md`, `gate-10-${gate.name}.md`]) {
          expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
          state.write(name, gate.content);
          expect(state.read(name)).toBe(gate.content);
        }
      }
    } finally {
      repo.cleanup();
    }
  });
});

describe("レビューの前置きの行のせいで、must なしの判定を must ありと読み、要らない修正の周に入った（PR #13 の 2 周目）", () => {
  // 最初の空でない行だけを読んでいたので、判定の前に 1 行書かれると判定を読めなかった。
  const preface = "ゲート周りの分岐を一通り追い終えた。結果をまとめる。";

  test("レビューは前置きの後の「判定:」の行を読む", () => {
    const actual = `${preface}\n\n判定: must なし\n- nit: x\n\n確かめたこと: y`;
    expect(prompts.reviewHasMust(actual)).toBe(false);
  });

  test("ゲートも前置きの後の「判定:」の行を読み、needs-human にしない", () => {
    const actual = `${preface}\n\n判定: 合格\n手順をすべて実行した。`;
    expect(prompts.parseGateVerdict(actual)).toBe("pass");
  });
});
