import { describe, expect, test } from "bun:test";
import {
  buildArgv,
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
    expect(parseAgentSpec("copilot:a:b")).toEqual({ agent: "copilot", models: [{ model: "a:b" }] });
  });

  test("知らないエージェントは拒否する", () => {
    expect(() => parseAgentSpec("codex")).toThrow(/unknown agent/);
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
    const flag = (agent: "claude" | "agy" | "copilot") => {
      const argv = buildArgv({ agent, effort: "high" }, "P");
      return argv[argv.indexOf("high") - 1];
    };
    expect(flag("claude")).toBe("--effort");
    expect(flag("agy")).toBe("--effort");
    expect(flag("copilot")).toBe("--reasoning-effort");
    expect(buildArgv({ agent: "claude" }, "P")).not.toContain("--effort");
  });

  test("エージェントごとの権限確認の飛ばし方", () => {
    expect(buildArgv({ agent: "agy" }, "P")).toContain("--dangerously-skip-permissions");
    expect(buildArgv({ agent: "copilot" }, "P")).toContain("--yolo");
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

  test("copilot は --session-id で始め、--resume=ID で続ける", () => {
    expect(buildArgv({ agent: "copilot" }, "P", start).join(" ")).toContain("--session-id u1");
    expect(buildArgv({ agent: "copilot" }, "P", resume)).toContain("--resume=u1");
  });

  test("会話を渡しても -p の直後がプロンプト", () => {
    for (const agent of ["claude", "agy", "copilot"] as const) {
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

  test("claude と copilot は渡した ID をそのまま使う", () => {
    expect(readSessionOutput("claude", start, "x")).toEqual({ session: "u1", text: "x" });
    expect(readSessionOutput("copilot", resume, "x")).toEqual({ session: "u1", text: "x" });
  });
});
