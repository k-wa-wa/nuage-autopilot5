import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, buildArgv } from "./agents.ts";
import { assignRoles } from "./models.ts";
import { runPipeline } from "./pipeline.ts";
import * as prompts from "./prompts.ts";
import { pipelineConfig, pipelineHarness } from "./testing/helpers.ts";

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
    expect(
      filesContaining(/--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox/),
    ).toEqual(["agents.ts"]);
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
    fix: prompts.fix({ mode: "pr", scope: "must-should", reviews: [], ciLog: null, inbox: null }),
    summarize: prompts.summarize("abc", 7),
  };

  for (const [kind, p] of Object.entries(autonomous)) {
    test(`${kind}: マージ・クローズ・既定ブランチへの push・.autopilot/ のコミット・機密情報の投稿を禁じ、質問させない`, () => {
      expect(p).toContain("PR のマージ");
      expect(p).toContain("Issue・PR のクローズ");
      expect(p).toContain("既定ブランチへの push");
      expect(p).toContain(".autopilot/ のコミット");
      expect(p).toContain("機密情報");
      expect(p).toContain("質問しない");
    });
  }

  test("レビュー担当には何も書かせない", () => {
    for (const p of prompts.REVIEW_PERSPECTIVES) {
      expect(prompts.review(p.slug, { baseSha: "abc", since: null })).toContain(
        "ファイルは一切変更しない",
      );
    }
  });
});

describe("人間がいない前提で動く", () => {
  test("どのエージェントも非対話・権限確認なしで起動する", () => {
    for (const agent of AGENTS) {
      const argv = buildArgv({ agent }, "PROMPT");
      expect(argv).toContain(agent === "codex" ? "exec" : "-p");
      expect(
        argv.some(
          (a) =>
            a === "--dangerously-skip-permissions" ||
            a === "--dangerously-bypass-approvals-and-sandbox",
        ),
      ).toBe(true);
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
    const hits = homeFiles(join(SRC, "../../../home")).filter((f) =>
      REAL_MODEL.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});

describe("全エージェント共通のルール（home/）", () => {
  const home = join(SRC, "../../../home");
  const rules = readFileSync(join(home, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(home, "skills", "autopilot", "SKILL.md"), "utf8");

  test("合意（OK）で autopilot に任せ、窓口自身は実装しない", () => {
    expect(rules).toContain("autopilot スキルで裏に任せる");
    expect(rules).toContain("自分で実装しない");
  });

  test("マージ・クローズ・既定ブランチへの push、機密情報の投稿を禁じる", () => {
    expect(rules).toMatch(/PR のマージ、Issue・PR のクローズ、既定ブランチへの push はしない/);
    expect(rules).toContain("機密情報");
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

describe("担当の切り替えの約束", () => {
  const roles = assignRoles({ level: "high" }, {});
  const cfg = { ...pipelineConfig(roles.implement, roles.reviewers), ...roles };

  test("通常は実装 agy、レビューは自由 claude・網羅 codex。同じ CLI の独立したレビューも指定できる", () => {
    expect(roles.implement.chain[0]!.agent).toBe("agy");
    expect(roles.reviewers).toHaveLength(2);
    expect(roles.reviewers[0]!.chain[0]!.agent).toBe("claude");
    expect(roles.reviewers[1]!.chain[0]!.agent).toBe("codex");
    expect(AGENTS).toEqual(["claude", "agy", "codex"]);
  });

  test("レビューの性質は観点で持ち、エージェントの違いに頼らない", () => {
    expect(prompts.REVIEW_PERSPECTIVES.map((p) => p.slug)).toEqual(["free", "coverage"]);
    for (const p of prompts.REVIEW_PERSPECTIVES) {
      const text = prompts.review(p.slug, { baseSha: "abc", since: null });
      expect(text).toContain("あなたはコードレビュアーである。ファイルは一切変更しない");
      expect(text).toContain(`「${prompts.VERDICT.must}」か「${prompts.VERDICT.none}」`);
    }
  });

  test("利用不能以外の失敗と変更途中の失敗では担当を切り替えない", async () => {
    for (const failure of ["error", "unavailable"] as const) {
      const h = pipelineHarness({
        commits: [],
        failure,
        failAgent: () => true,
        dirtyOnFail: () => failure === "unavailable",
      });
      expect((await runPipeline(cfg, h.deps)).kind).toBe("failed");
      expect(h.calls).toHaveLength(1);
    }
  });

  test("窓口スキルは通常の起動で担当を明示しない", () => {
    const skill = readFileSync(join(SRC, "../../../home/skills/autopilot/SKILL.md"), "utf8");
    const examples = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(examples).toContain("   autopilot-run\n   ");
    for (const example of examples) expect(example).not.toMatch(/--impl|--reviewers/);
    expect(skill).toContain("特別な指示がない限り --impl と --reviewers は使わない");
  });
});
