import { describe, expect, test } from "bun:test";
import { parseStartOptions } from "./main.ts";

const base = { impl: "claude", reviewers: "agy", "max-rounds": "3", local: false };
const onPath =
  (...names: string[]) =>
  async (n: string) =>
    names.includes(n);

describe("parseStartOptions", () => {
  test("省略時は実装 agy・レビューは自由 claude・網羅 codex。PATH から担当を増やさない", async () => {
    const o = await parseStartOptions(
      { "max-rounds": "3", local: false },
      onPath("claude", "agy", "codex"),
    );
    expect(o.impl).toBeUndefined();
    expect(o.reviewers).toBeUndefined();
  });

  test("既定担当が PATH に無ければ別候補を選ばず拒否する", async () => {
    await expect(
      parseStartOptions({ "max-rounds": "3", local: false }, onPath("claude", "codex")),
    ).rejects.toThrow(/CLI が PATH にない: agy/);
    await expect(
      parseStartOptions({ impl: "agy", "max-rounds": "3", local: false }, onPath("agy")),
    ).rejects.toThrow(/CLI が PATH にない: claude/);
    await expect(
      parseStartOptions({ "max-rounds": "3", local: false }, onPath("agy", "claude")),
    ).rejects.toThrow(/CLI が PATH にない: codex/);
  });

  test("設定の先頭担当を検証する。実装とレビューが同じ CLI でもよい", async () => {
    const o = await parseStartOptions({ "max-rounds": "3", local: false }, onPath("codex"), {
      roles: { impl: ["codex"], review: ["codex"] },
    });
    expect(o.impl).toBeUndefined();
  });

  test("--reviewers を明示したら PATH を見ない", async () => {
    const o = await parseStartOptions(
      { ...base, reviewers: "agy:model-a/model-b,codex" },
      onPath(),
    );
    expect(o.reviewers).toEqual([
      { agent: "agy", models: [{ model: "model-a" }, { model: "model-b" }] },
      { agent: "codex", models: [] },
    ]);
  });

  test("同じレビュー担当の重複も許容する（ファイル名は観点で決まるため）", async () => {
    const o = await parseStartOptions({ ...base, reviewers: "agy,agy" }, onPath());
    expect(o.reviewers).toHaveLength(2);
  });

  test("観点数を超えるレビュー担当は拒否する", async () => {
    await expect(
      parseStartOptions({ ...base, reviewers: "agy,claude,codex" }, onPath()),
    ).rejects.toThrow(/--reviewers は観点の数（2）以下で指定すること/);
  });

  test("モデル違いの同じエージェントは並べてよい", async () => {
    const o = await parseStartOptions({ ...base, reviewers: "agy:a,agy:b" }, onPath());
    expect(o.reviewers).toHaveLength(2);
  });

  test("知らないエージェントは拒否する", async () => {
    await expect(parseStartOptions({ ...base, impl: "copilot" }, onPath())).rejects.toThrow(
      /unknown/,
    );
    await expect(
      parseStartOptions({ ...base, reviewers: "agy,copilot" }, onPath()),
    ).rejects.toThrow(/unknown/);
  });

  test("--level の既定は high で、段階の名前だけ受け付ける", async () => {
    expect((await parseStartOptions(base, onPath("agy"))).level).toBe("high");
    expect((await parseStartOptions({ ...base, level: "standard" }, onPath("agy"))).level).toBe(
      "standard",
    );
    for (const bad of ["low", "High", ""]) {
      await expect(parseStartOptions({ ...base, level: bad }, onPath("agy"))).rejects.toThrow(
        /--level/,
      );
    }
  });

  test("--max-rounds は 1〜10 の整数だけ受け付ける", async () => {
    for (const bad of ["abc", "0", "-1", "1.5", "11", ""]) {
      await expect(
        parseStartOptions({ ...base, "max-rounds": bad }, onPath("agy")),
      ).rejects.toThrow(/max-rounds/);
    }
    expect((await parseStartOptions({ ...base, "max-rounds": "1" }, onPath("agy"))).maxRounds).toBe(
      1,
    );
  });

  test("--from の既定は implement で、implement と review だけ受け付ける", async () => {
    expect((await parseStartOptions(base, onPath("agy"))).from).toBe("implement");
    expect((await parseStartOptions({ ...base, from: "review" }, onPath("agy"))).from).toBe(
      "review",
    );
    for (const bad of ["fix", "Review", ""]) {
      await expect(parseStartOptions({ ...base, from: bad }, onPath("agy"))).rejects.toThrow(
        /--from/,
      );
    }
  });
});
