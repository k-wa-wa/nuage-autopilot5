import { describe, expect, test } from "bun:test";
import {
  buildArgv,
  classifyFailure,
  formatAgentSpec,
  formatInvocation,
  parseAgentSpec,
  parseModelChoice,
  readSessionOutput,
} from "./agents.ts";

describe("parseModelChoice", () => {
  test("モデルと effort を @ で分ける", () => {
    expect(parseModelChoice("m")).toEqual({ model: "m" });
    expect(parseModelChoice("m@high")).toEqual({ model: "m", effort: "high" });
    expect(parseModelChoice("@low")).toEqual({ effort: "low" });
    expect(parseModelChoice(" m@high ")).toEqual({ model: "m", effort: "high" });
  });

  test("空や effort の抜けは拒否する", () => {
    expect(() => parseModelChoice("")).toThrow(/空/);
    expect(() => parseModelChoice("m@")).toThrow(/effort/);
  });
});

describe("利用不能と通常の失敗を区別する", () => {
  test("認証・利用枠・会話の上限だけが切り替え対象", () => {
    for (const agent of ["claude", "agy", "codex"] as const) {
      for (const stderr of [
        "You've hit your usage limit",
        "Rate limit exceeded",
        "RESOURCE_EXHAUSTED",
        "OAuth token has expired",
        "Session expired",
        "Conversation not found",
        "context_length_exceeded",
        "Prompt is too long",
        "Not logged in. Please run login.",
      ]) {
        expect(classifyFailure(agent, { code: 1, stdout: "", stderr })).toBe("unavailable");
      }
      for (const stderr of [
        "ECONNRESET",
        "stream disconnected before completion",
        "Internal server error",
        "tests failed",
        "unknown model",
        "invalid argument",
        "permission denied",
      ]) {
        expect(classifyFailure(agent, { code: 1, stdout: "", stderr })).toBe("error");
      }
      expect(
        classifyFailure(agent, { code: 0, stdout: "Rate limit exceeded", stderr: "" }),
      ).toBeNull();
      expect(classifyFailure(agent, { code: 127, stdout: "", stderr: "Session expired" })).toBe(
        "error",
      );
      expect(classifyFailure(agent, { code: 143, stdout: "", stderr: "Session expired" })).toBe(
        "error",
      );
    }
  });

  test("Codex の失敗イベントを解釈し、ツール出力や本文中のエラー例には反応しない", () => {
    const stdout = JSON.stringify({
      type: "turn.failed",
      error: { message: "You've hit your usage limit" },
    });
    expect(classifyFailure("codex", { code: 1, stdout, stderr: "" })).toBe("unavailable");
    expect(classifyFailure("codex", { code: 0, stdout, stderr: "" })).toBe("unavailable");
    const toolOutput = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", aggregated_output: "Rate limit exceeded" },
    });
    expect(
      classifyFailure("codex", { code: 1, stdout: toolOutput, stderr: "connection lost" }),
    ).toBe("error");
  });
});

describe("parseAgentSpec", () => {
  test("エージェントだけなら、モデルは models.yaml に任せる（空の並び）", () => {
    expect(parseAgentSpec(" claude ")).toEqual({ agent: "claude", models: [] });
    expect(parseAgentSpec("claude:")).toEqual({ agent: "claude", models: [] });
  });

  test("モデルの並びを / で読む", () => {
    expect(parseAgentSpec("agy:model-a/model-b@high")).toEqual({
      agent: "agy",
      models: [{ model: "model-a" }, { model: "model-b", effort: "high" }],
    });
  });

  test("モデル名に : を含んでもよい", () => {
    expect(parseAgentSpec("codex:a:b")).toEqual({ agent: "codex", models: [{ model: "a:b" }] });
  });

  test("知らないエージェントは拒否する", () => {
    expect(() => parseAgentSpec("copilot")).toThrow(/unknown agent/);
    expect(() => parseAgentSpec("")).toThrow(/unknown agent/);
  });

  test("formatAgentSpec と往復する", () => {
    for (const text of ["claude", "agy:model-a", "claude:model-a@high/model-b"]) {
      expect(formatAgentSpec(parseAgentSpec(text))).toBe(text);
    }
  });
});

describe("formatInvocation", () => {
  test("ログに出す形", () => {
    expect(formatInvocation({ agent: "claude" })).toBe("claude");
    expect(formatInvocation({ agent: "claude", model: "m", effort: "high" })).toBe("claude:m@high");
  });
});

describe("buildArgv", () => {
  test("モデルを渡したときだけ --model を付ける", () => {
    expect(buildArgv({ agent: "claude" }, "P")).not.toContain("--model");
    expect(buildArgv({ agent: "claude", model: "m" }, "P")).toEqual([
      "claude",
      "--model",
      "m",
      "--dangerously-skip-permissions",
      "-p",
      "P",
    ]);
  });

  test("effort はエージェントごとのフラグで渡す", () => {
    const flag = (agent: "claude" | "agy" | "codex") => {
      const argv = buildArgv({ agent, effort: "high" }, "P");
      return argv[argv.indexOf("high") - 1];
    };
    expect(flag("claude")).toBe("--effort");
    expect(flag("agy")).toBe("--effort");
    expect(buildArgv({ agent: "codex", effort: "high" }, "P")).toContain(
      'model_reasoning_effort="high"',
    );
    expect(buildArgv({ agent: "claude" }, "P")).not.toContain("--effort");
  });

  test("エージェントごとの権限確認の飛ばし方", () => {
    expect(buildArgv({ agent: "agy" }, "P")).toContain("--dangerously-skip-permissions");
    expect(buildArgv({ agent: "codex" }, "P")).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });
});

describe("会話の引き継ぎ", () => {
  const start = { kind: "start", id: "u1" } as const;
  const resume = { kind: "resume", id: "u1" } as const;

  test("claude は会話 ID を先に決め、--resume で続ける", () => {
    expect(buildArgv({ agent: "claude" }, "P", start)).toContain("--session-id");
    expect(buildArgv({ agent: "claude" }, "P", resume).join(" ")).toContain("--resume u1");
  });

  test("agy は ID を先に決められないので JSON で受け取り、--conversation で続ける", () => {
    const s = buildArgv({ agent: "agy" }, "P", start).join(" ");
    expect(s).toContain("--output-format json");
    expect(s).not.toContain("u1");
    expect(buildArgv({ agent: "agy" }, "P", resume).join(" ")).toContain("--conversation u1");
  });

  test("codex は exec で始め、exec resume ID で続ける", () => {
    const first = buildArgv({ agent: "codex" }, "P", start);
    expect(first.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(first).toContain("--json");
    expect(first).not.toContain("u1");
    const next = buildArgv({ agent: "codex", model: "m", effort: "high" }, "P", resume);
    expect(next.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(next.slice(-3)).toEqual(["u1", "--", "P"]);
    expect(next).toContain("--model");
    expect(next).toContain('model_reasoning_effort="high"');
  });

  test("会話を渡しても -p の直後がプロンプト", () => {
    for (const agent of ["claude", "agy"] as const) {
      for (const s of [start, resume]) {
        expect(buildArgv({ agent, model: "m" }, "P", s).slice(-2)).toEqual(["-p", "P"]);
      }
    }
  });

  test("agy の JSON から会話 ID と本文を読む", () => {
    const out = JSON.stringify({ conversation_id: "c9", status: "SUCCESS", response: "done\n" });
    expect(readSessionOutput("agy", start, out)).toEqual({ session: "c9", text: "done\n" });
  });

  test("agy の出力が JSON でなければ、会話 ID は null にして本文はそのまま残す", () => {
    expect(readSessionOutput("agy", start, "text")).toEqual({ session: null, text: "text" });
    expect(readSessionOutput("agy", start, "{}")).toEqual({ session: null, text: "{}" });
    const empty = JSON.stringify({ conversation_id: "", response: "" });
    expect(readSessionOutput("agy", start, empty)).toEqual({ session: null, text: "" });
  });

  test("claude は渡した ID をそのまま使う", () => {
    expect(readSessionOutput("claude", start, "x")).toEqual({ session: "u1", text: "x" });
  });
});

describe("codex JSONL の読み取り", () => {
  const start = { kind: "start", id: "unused" } as const;
  test("会話 ID と最後のエージェント本文だけを取り出す", () => {
    const out = [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { type: "agent_message", text: "途中" } },
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "noise" } },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "判定: must なし\n確かめたこと" },
      },
      { type: "turn.completed", usage: {} },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(readSessionOutput("codex", start, out)).toEqual({
      session: "thread-1",
      text: "判定: must なし\n確かめたこと",
    });
    expect(readSessionOutput("codex", undefined, out).text).toStartWith("判定:");
  });
  test("会話 ID の欠落や壊れた行で、架空の ID を返さない", () => {
    expect(readSessionOutput("codex", start, "bad\n{}")).toEqual({ session: null, text: "" });
    expect(readSessionOutput("codex", { kind: "resume", id: "old" }, "").session).toBe("old");
  });
});
