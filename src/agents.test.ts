import { describe, expect, test } from "bun:test";
import { buildArgv, formatAgentSpec, parseAgentSpec } from "./agents.ts";

describe("parseAgentSpec", () => {
  test("モデル指定を読む", () => {
    expect(parseAgentSpec("agy:gemini-3.8-flash-high")).toEqual({
      agent: "agy",
      model: "gemini-3.8-flash-high",
    });
    expect(parseAgentSpec(" claude ")).toEqual({ agent: "claude" });
    expect(parseAgentSpec("claude:")).toEqual({ agent: "claude" });
  });

  test("モデル名に : を含んでもよい", () => {
    expect(parseAgentSpec("copilot:a:b")).toEqual({ agent: "copilot", model: "a:b" });
  });

  test("知らないエージェントは拒否する", () => {
    expect(() => parseAgentSpec("codex")).toThrow(/unknown agent/);
    expect(() => parseAgentSpec("")).toThrow(/unknown agent/);
  });

  test("formatAgentSpec と往復する", () => {
    for (const text of ["claude", "agy:gemini-3.8-flash-high"]) {
      expect(formatAgentSpec(parseAgentSpec(text))).toBe(text);
    }
  });
});

describe("buildArgv", () => {
  test("モデルを渡したときだけ --model を付ける", () => {
    expect(buildArgv({ agent: "claude" }, "P")).not.toContain("--model");
    expect(buildArgv({ agent: "claude", model: "opus" }, "P")).toEqual([
      "claude",
      "--model",
      "opus",
      "--dangerously-skip-permissions",
      "-p",
      "P",
    ]);
  });

  test("エージェントごとの権限確認の飛ばし方", () => {
    expect(buildArgv({ agent: "agy" }, "P")).toContain("--dangerously-skip-permissions");
    expect(buildArgv({ agent: "copilot" }, "P")).toContain("--yolo");
  });
});
