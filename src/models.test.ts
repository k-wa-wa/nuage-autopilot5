import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentSpec } from "./agents.ts";
import {
  assignRoles,
  formatModelTable,
  loadModelTable,
  parseModelTable,
  resolveChain,
} from "./models.ts";
import { tempDir } from "./testing/helpers.ts";

const YAML = `
# コメントを書ける
claude:
  high: [model-big@high]
  standard: [model-mid@medium]
  light: [model-small@low]
agy:
  high:
    - model-x-high
    - model-y-high
`;

describe("parseModelTable", () => {
  test("エージェント → 段階 → モデルの並びを読む", () => {
    expect(parseModelTable(YAML)).toEqual({
      claude: {
        high: [{ model: "model-big", effort: "high" }],
        standard: [{ model: "model-mid", effort: "medium" }],
        light: [{ model: "model-small", effort: "low" }],
      },
      agy: { high: [{ model: "model-x-high" }, { model: "model-y-high" }] },
    });
  });

  test("空のファイルは表なし", () => {
    expect(parseModelTable("")).toEqual({});
    expect(parseModelTable("# なし\n")).toEqual({});
  });

  test("書き間違いは場所を添えて拒否する（黙って既定モデルにしない）", () => {
    expect(() => parseModelTable("codex:\n  high: [m]\n")).toThrow(/知らないエージェント: codex/);
    expect(() => parseModelTable("claude:\n  hgih: [m]\n")).toThrow(/知らない段階: hgih/);
    expect(() => parseModelTable("claude:\n  high: m\n")).toThrow(/claude\.high/);
    expect(() => parseModelTable("claude:\n  high: []\n")).toThrow(/1 つ以上/);
    expect(() => parseModelTable("claude:\n  high: [1]\n")).toThrow(/claude\.high\[0\]/);
    expect(() => parseModelTable("claude:\n  high: ['m@']\n")).toThrow(/claude\.high\[0\]/);
    expect(() => parseModelTable("- a\n")).toThrow(/エージェントごとの表/);
    expect(() => parseModelTable("claude: [m]\n")).toThrow(/段階ごとの表/);
  });
});

describe("loadModelTable", () => {
  let dir: ReturnType<typeof tempDir>;
  afterEach(() => dir?.cleanup());

  test("ファイルが無ければ null（各 CLI の既定モデルで動く）", () => {
    dir = tempDir();
    expect(loadModelTable(join(dir.path, "none.yaml"))).toBeNull();
  });

  test("ファイルを読む", () => {
    dir = tempDir();
    const path = join(dir.path, "models.yaml");
    writeFileSync(path, YAML);
    expect(loadModelTable(path)?.agy?.high).toHaveLength(2);
  });
});

describe("resolveChain", () => {
  const table = parseModelTable(YAML);

  test("段階の並びを使う", () => {
    expect(resolveChain(parseAgentSpec("agy"), "high", table)).toEqual([
      { agent: "agy", model: "model-x-high" },
      { agent: "agy", model: "model-y-high" },
    ]);
  });

  test("モデルを明示した担当には段階を使わない", () => {
    expect(resolveChain(parseAgentSpec("agy:m1"), "light", table)).toEqual([
      { agent: "agy", model: "m1" },
    ]);
  });

  test("表に無ければ CLI の既定モデルで 1 回だけ試す", () => {
    expect(resolveChain(parseAgentSpec("agy"), "light", table)).toEqual([{ agent: "agy" }]);
    expect(resolveChain(parseAgentSpec("copilot"), "high", {})).toEqual([{ agent: "copilot" }]);
  });
});

describe("assignRoles", () => {
  const table = parseModelTable(YAML);
  const roles = (level: "high" | "standard" | "light") =>
    assignRoles(
      { impl: parseAgentSpec("claude"), reviewers: [parseAgentSpec("agy")], level },
      table,
    );
  const models = (a: { chain: { model?: string }[] }) => a.chain.map((i) => i.model);

  test("実装と修正は --level の段階を使う", () => {
    expect(models(roles("standard").implement)).toEqual(["model-mid"]);
    expect(models(roles("standard").fix)).toEqual(["model-mid"]);
    expect(models(roles("high").implement)).toEqual(["model-big"]);
  });

  test("レビューは常に high、要約は常に light", () => {
    for (const level of ["high", "standard", "light"] as const) {
      expect(models(roles(level).reviewers[0]!)).toEqual(["model-x-high", "model-y-high"]);
      expect(models(roles(level).summarize)).toEqual(["model-small"]);
    }
  });

  test("担当の名前は指定のまま（ログとレビューのファイル名に使う）", () => {
    expect(roles("high").implement.name).toBe("claude");
    expect(roles("high").reviewers.map((r) => r.name)).toEqual(["agy"]);
  });
});

describe("formatModelTable", () => {
  test("段階ごとに試す順で表示する", () => {
    expect(formatModelTable(parseModelTable(YAML))).toBe(
      [
        "claude:",
        "  high     model-big@high",
        "  standard model-mid@medium",
        "  light    model-small@low",
        "agy:",
        "  high     model-x-high → model-y-high",
      ].join("\n"),
    );
  });
});
