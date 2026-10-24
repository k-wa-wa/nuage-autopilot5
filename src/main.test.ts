import { describe, expect, test } from "bun:test";
import { parseStartOptions } from "./main.ts";

const base = { impl: "claude", "max-rounds": "3", local: false };
const onPath =
  (...names: string[]) =>
  async (n: string) =>
    names.includes(n);

describe("parseStartOptions", () => {
  test("レビュー担当の既定は、実装担当以外で PATH にあるもの全部", async () => {
    const o = await parseStartOptions(base, onPath("claude", "agy", "copilot"));
    expect(o.reviewers).toEqual([
      { agent: "agy", models: [] },
      { agent: "copilot", models: [] },
    ]);
    const o2 = await parseStartOptions({ ...base, impl: "agy" }, onPath("claude", "agy"));
    expect(o2.reviewers).toEqual([{ agent: "claude", models: [] }]);
  });

  test("レビュー担当がいなければ起動しない（レビュー無しで完了にしない）", async () => {
    await expect(parseStartOptions(base, onPath("claude"))).rejects.toThrow(/レビュー担当がいない/);
  });

  test("--reviewers を明示したら PATH を見ない", async () => {
    const o = await parseStartOptions(
      { ...base, reviewers: "agy:model-a/model-b,copilot" },
      onPath(),
    );
    expect(o.reviewers).toEqual([
      { agent: "agy", models: [{ model: "model-a" }, { model: "model-b" }] },
      { agent: "copilot", models: [] },
    ]);
  });

  test("同じレビュー担当の重複は拒否する（同じファイルに書き合う）", async () => {
    await expect(parseStartOptions({ ...base, reviewers: "agy,agy" }, onPath())).rejects.toThrow(
      /重複/,
    );
  });

  test("モデル違いの同じエージェントは並べてよい", async () => {
    const o = await parseStartOptions({ ...base, reviewers: "agy:a,agy:b" }, onPath());
    expect(o.reviewers).toHaveLength(2);
  });

  test("知らないエージェントは拒否する", async () => {
    await expect(parseStartOptions({ ...base, impl: "codex" }, onPath())).rejects.toThrow(
      /unknown/,
    );
    await expect(parseStartOptions({ ...base, reviewers: "agy,codex" }, onPath())).rejects.toThrow(
      /unknown/,
    );
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
});
