import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, buildArgv } from "./agents.ts";
import * as prompts from "./prompts.ts";

/**
 * 設計の約束（AGENTS.md「設計の約束」と home/）が守られているかのテスト。
 * 「A で宣言した規則が B で強制されていない」形の欠陥を、散文ではなくここで防ぐ。
 */

const SRC = import.meta.dir;
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ name: f, text: readFileSync(join(SRC, f), "utf8") }));

/** pattern を含むソースファイル名（テストを除く）。 */
const filesContaining = (pattern: RegExp) =>
  sources.filter((s) => pattern.test(s.text)).map((s) => s.name);

describe("責務が 1 箇所に閉じている", () => {
  test("エージェント CLI の起動方法は agents.ts だけが知る", () => {
    expect(filesContaining(/--dangerously-skip-permissions|--yolo/)).toEqual(["agents.ts"]);
  });

  test("gh の呼び出しは github.ts だけが行う", () => {
    expect(filesContaining(/\["gh"/)).toEqual(["github.ts"]);
  });

  test("Orca の環境変数を扱うのは exec.ts だけ", () => {
    expect(filesContaining(/ORCA_/)).toEqual(["exec.ts"]);
  });

  test("CI の判定（pass / fail の解釈）は ci.ts だけが行う", () => {
    expect(filesContaining(/"cancel"/).sort()).toEqual(["ci.ts", "github.ts"]);
    expect(filesContaining(/judgeCi\(/).sort()).toEqual(["ci.ts", "pipeline.ts"]);
  });

  test("作業ごとの賢さ（段階）は models.ts だけが決める", () => {
    expect(filesContaining(/"(standard|light)"/)).toEqual(["models.ts"]);
  });

  test("流れ（pipeline.ts）は子プロセスもファイルも直接触らない（依存は Deps で受ける）", () => {
    const pipeline = sources.find((s) => s.name === "pipeline.ts")!.text;
    expect(pipeline).not.toMatch(/from "node:|from "\.\/exec\.ts"|from "\.\/state\.ts"|Bun\./);
  });
});

describe("禁止事項はすべての自律ターンに届く", () => {
  const autonomous = {
    implement: prompts.implement("pr"),
    fix: prompts.fix({ mode: "pr", reviews: [], ciLog: null, inbox: null }),
    summarize: prompts.summarize("abc", 7),
  };

  for (const [kind, p] of Object.entries(autonomous)) {
    test(`${kind}: マージ・クローズ・既定ブランチへの push・.autopilot/ のコミットを禁じ、質問させない`, () => {
      expect(p).toContain("PR のマージ");
      expect(p).toContain("Issue・PR のクローズ");
      expect(p).toContain("既定ブランチへの push");
      expect(p).toContain(".autopilot/ のコミット");
      expect(p).toContain("質問しない");
    });
  }

  test("レビュー担当には何も書かせない", () => {
    expect(prompts.review("abc")).toContain("ファイルは一切変更しない");
  });
});

describe("人間がいない前提で動く", () => {
  test("どのエージェントも非対話・権限確認なしで起動する", () => {
    for (const agent of AGENTS) {
      const argv = buildArgv({ agent }, "PROMPT");
      expect(argv).toContain("-p");
      expect(argv.some((a) => a === "--dangerously-skip-permissions" || a === "--yolo")).toBe(true);
    }
  });
});

describe("モデル名は models.yaml だけに書く", () => {
  // モデルは頻繁に変わる。コードや説明文に書くと、更新のたびに直す場所が散らばり、古い名前が残る。
  const REAL_MODEL = /\b(gemini-\d|claude-(opus|sonnet|haiku|fable)|gpt-\d|gpt-oss)/;
  const homeFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? homeFiles(join(dir, e.name)) : [join(dir, e.name)],
    );

  test("コード（テストも含む）に実在のモデル名を書かない", () => {
    const all = readdirSync(SRC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && f !== "invariants.test.ts");
    const hits = all.filter((f) => REAL_MODEL.test(readFileSync(join(SRC, f), "utf8")));
    expect(hits).toEqual([]);
  });

  test("home/（窓口が読むルールとスキル）に実在のモデル名を書かない", () => {
    const hits = homeFiles(join(SRC, "..", "home")).filter((f) =>
      REAL_MODEL.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});

describe("全エージェント共通のルール（home/）", () => {
  const home = join(SRC, "..", "home");
  const rules = readFileSync(join(home, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(home, "skills", "autopilot", "SKILL.md"), "utf8");

  test("合意（OK）で autopilot に任せ、窓口自身は実装しない", () => {
    expect(rules).toContain("autopilot スキルで裏に任せる");
    expect(rules).toContain("自分で実装しない");
  });

  test("マージ・クローズ・既定ブランチへの push を禁じる", () => {
    expect(rules).toMatch(/PR のマージ、Issue・PR のクローズ、既定ブランチへの push はしない/);
  });

  test("スキルは実在するコマンドとファイルだけを案内する", () => {
    expect(skill).toContain("autopilot-run");
    for (const f of ["brief.md", "inbox.md", "status", "result.md", "run.log"]) {
      expect(skill).toContain(f);
    }
    // スキルが案内するオプションは main.ts が受け付けるものだけ
    const main = sources.find((s) => s.name === "main.ts")!.text;
    const opts = skill.match(/--[a-z][a-z-]+/g) ?? [];
    expect(opts.length).toBeGreaterThan(0);
    for (const opt of opts) {
      const name = opt.slice(2);
      // parseArgs の options に `name: {` か `"name": {` で定義されている
      expect(main).toMatch(new RegExp(`(^|\\s)("${name}"|${name}): \\{ type:`, "m"));
    }
  });

  test("autopilot-run をシェルから切り離して起動させない（終わっても窓口が起こされない）", () => {
    expect(skill).toContain("シェルから切り離さない");
  });

  test("スキルの frontmatter に name と description がある（エージェントが見つけられる）", () => {
    expect(skill).toMatch(/^---\nname: autopilot\ndescription: .+\n---/);
  });
});
