import { describe, expect, test } from "bun:test";
import {
  buildArgv,
  formatAgentSpec,
  formatInvocation,
  parseAgentSpec,
  parseModelChoice,
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
