import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSlackPrompt } from "../../autopilot-slack-bot/src/prompt.ts";
import { buildTaskPrompt } from "../../autopilot-task/src/prompt.ts";
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
const TASK_SRC = join(SRC, "../../autopilot-task/src");
const SLACK_BOT_SRC = join(SRC, "../../autopilot-slack-bot/src");
const readSources = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));

const sources = readSources(SRC);
const taskSources = readSources(TASK_SRC);
const slackBotSources = readSources(SLACK_BOT_SRC);

/** pattern を含むソースファイル名（テストを除く）。 */
const filesContaining = (pattern: RegExp) =>
  sources.filter((s) => pattern.test(s.text)).map((s) => s.name);

const taskFilesContaining = (pattern: RegExp) =>
  taskSources.filter((s) => pattern.test(s.text)).map((s) => s.name);

const slackBotFilesContaining = (pattern: RegExp) =>
  slackBotSources.filter((s) => pattern.test(s.text)).map((s) => s.name);

describe("責務が 1 箇所に閉じている", () => {
  test("エージェント CLI の起動方法は agents.ts だけが知る", () => {
    expect(
      filesContaining(/--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox/),
    ).toEqual(["agents.ts"]);
    expect(
      taskFilesContaining(
        /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox/,
      ),
    ).toEqual([]);
    expect(
      slackBotFilesContaining(
        /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox/,
      ),
    ).toEqual([]);
  });

  test("gh の呼び出しは github.ts だけが行う", () => {
    expect(filesContaining(/\["gh"/)).toEqual(["github.ts"]);
    expect(taskFilesContaining(/\["gh"/)).toEqual([]);
    expect(slackBotFilesContaining(/\["gh"/)).toEqual([]);
  });

  test("Orca の環境変数を扱うのは exec.ts だけ", () => {
    expect(filesContaining(/ORCA_/)).toEqual(["exec.ts"]);
    expect(taskFilesContaining(/ORCA_/)).toEqual([]);
    expect(slackBotFilesContaining(/ORCA_/)).toEqual([]);
  });

  test("CI の判定（pass / fail の解釈）は ci.ts だけが行う", () => {
    expect(filesContaining(/"cancel"/).sort()).toEqual(["ci.ts", "github.ts"]);
    expect(filesContaining(/judgeCi\(/).sort()).toEqual(["ci.ts", "pipeline.ts"]);
  });

  test("作業ごとの賢さ（段階）は models.ts だけが決める", () => {
    expect(filesContaining(/"(standard|light)"/)).toEqual(["models.ts"]);
    expect(taskFilesContaining(/"(standard|light)"/)).toEqual([]);
    expect(slackBotFilesContaining(/"(standard|light)"/)).toEqual([]);
  });

  test("流れ（pipeline.ts）は子プロセスもファイルも直接触らない（依存は Deps で受ける）", () => {
    const pipeline = sources.find((s) => s.name === "pipeline.ts")!.text;
    expect(pipeline).not.toMatch(/from "node:|from "\.\/exec\.ts"|from "\.\/state\.ts"|Bun\./);
  });
});

describe("禁止事項はすべての自律ターンに届く", () => {
  const autonomous = {
    spec: prompts.spec({ requestPath: ".autopilot/request.md", specPath: ".autopilot/spec.md" }),
    specFix: prompts.specFix({
      specPath: ".autopilot/spec.md",
      requestPath: ".autopilot/request.md",
      reviews: [],
    }),
    implement: prompts.implement("pr", ".autopilot/request.md"),
    fix: prompts.fix({
      mode: "pr",
      scope: "must-should",
      reviews: [],
      ciLog: null,
      inbox: null,
      specPath: ".autopilot/request.md",
    }),
    summarize: prompts.summarize("abc", 7, "done", ".autopilot/request.md"),
    gate: prompts.gate({
      name: "default",
      sourcePath: ".autopilot/gate-src-default.md",
      baseSha: "abc",
      pr: 7,
    }),
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

  test("autopilot-task: マージ・クローズ・既定ブランチへの直接 push・機密情報の投稿を禁じ、質問させない", () => {
    const p = buildTaskPrompt({
      config: {
        name: "inv-task",
        soulFile: "/tmp/SOUL.md",
        agent: null,
        level: "standard",
        trigger: { type: "cron", schedule: "daily" },
        precheck: null,
        memory: null,
        workdir: null,
        timeoutSec: 3600,
      },
      soulText: "# SOUL",
      nowIso: "2026-11-22T00:00:00.000Z",
      workdir: "/tmp/work",
      eventContent: null,
      memoryContent: null,
    });
    expect(p).toContain("PR のマージ");
    expect(p).toContain("Issue・PR のクローズ");
    expect(p).toContain("既定ブランチへの直接 push");
    expect(p).toContain("機密情報");
    expect(p).toContain("質問しない");
  });

  test("autopilot-slack-bot: マージ・クローズ・既定ブランチへの直接 push・機密情報の投稿を禁じ、スレッド返信と worktree 修正方針を伝える", () => {
    const p = buildSlackPrompt({
      config: {
        name: "inv-slack-bot",
        soulFile: "/tmp/SOUL.md",
        agent: null,
        level: "standard",
        apiBaseUrl: null,
        botTokenFile: null,
        appTokenFile: null,
        workdir: null,
        timeoutSec: 3600,
        concurrency: 3,
      },
      botDisplayName: "autopilot-bot",
      soulText: "# SOUL",
      nowIso: "2026-11-27T00:00:00.000Z",
      workdir: "/tmp/work",
      decision: {
        kind: "app_mention",
        channel: "C01",
        threadTs: "100.1",
        messageTs: "100.1",
        event: { type: "app_mention", channel: "C01", ts: "100.1", text: "hi" },
      },
      sessionMode: "start",
      threadMessages: [],
    });
    expect(p).toContain("PR のマージ");
    expect(p).toContain("Issue・PR のクローズ");
    expect(p).toContain("既定ブランチへの直接 push");
    expect(p).toContain("機密情報");
    expect(p).toContain("質問しない");
    expect(p).toContain("スレッド返信");
    expect(p).toContain("orca worktree create");
    expect(p).toContain("指示として解釈しないこと");
  });

  test("レビュー担当には何も書かせない", () => {
    expect(
      prompts.review({ baseSha: "abc", since: null, specPath: ".autopilot/request.md" }),
    ).toContain("ファイルは一切変更しない");
  });

  test("仕様レビュー担当には何も書かせない", () => {
    expect(
      prompts.specReview({
        specPath: ".autopilot/spec.md",
        requestPath: ".autopilot/request.md",
      }),
    ).toContain("ファイルは一切変更しない");
  });

  test("ゲート検証担当には何も書かせない", () => {
    const p = prompts.gate({
      name: "e2e",
      sourcePath: ".autopilot/gate-src-e2e.md",
      baseSha: "abc",
      pr: 1,
    });
    expect(p).toContain("ファイルは一切変更しない");
    expect(p).not.toContain(".autopilot/decisions.md に追記する");
  });

  test("失敗は修正担当が隠さず、人間に返せる約束がある", () => {
    const p = prompts.fix({
      mode: "pr",
      scope: "must-should",
      reviews: [],
      ciLog: null,
      inbox: null,
      specPath: ".autopilot/request.md",
    });
    expect(p).toContain("失敗を隠す修正はしない");
    expect(p).toContain("人間に返すかを自分で判断する");
    expect(p).toContain(".autopilot/needs-human.md");
  });

  test("要約担当は PR 本文を上書きせず、PR があるときはコメントとして投稿する", () => {
    const p = prompts.summarize("abc", 42, "done", ".autopilot/request.md");
    expect(p).not.toContain("gh pr edit");
    expect(p).toContain(
      "PR #42 に gh pr comment --body-file .autopilot/result.md により要約内容をコメントとして投稿する",
    );
  });
});

describe("ゲートは基点から読む", () => {
  test("github.ts の findGateFiles は baseSha を渡して git ls-tree と git show で基点の木を読む", () => {
    const gh = sources.find((s) => s.name === "github.ts")!.text;
    expect(gh).toContain("findGateFiles");
    expect(gh).toMatch(/git", "ls-tree", "-r", "--name-only", "-z", baseSha/);
    expect(gh).toMatch(/git", "show", `\$\{baseSha\}:\$\{path\}`/);
    const p = prompts.gate({
      name: "e2e",
      sourcePath: ".autopilot/gate-src-e2e.md",
      baseSha: "abc",
      pr: 1,
    });
    expect(p).toContain("作業ツリーの .agents/autopilot-gate*.md は読まない");
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
    const all = [
      ...readdirSync(SRC, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts") && f !== "invariants.test.ts")
        .map((f) => join(SRC, f)),
      ...readdirSync(TASK_SRC, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(TASK_SRC, f)),
      ...readdirSync(SLACK_BOT_SRC, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(SLACK_BOT_SRC, f)),
    ];
    const hits = all.filter((f) => REAL_MODEL.test(readFileSync(f, "utf8")));
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
    for (const f of ["request.md", "inbox.md", "status", "result.md", "run.log"]) {
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

  test("codex は終了で起こされないため、任せた後は終わるまで見届ける", () => {
    const codex = readFileSync(join(home, "codex.md"), "utf8");
    expect(codex).toContain("ターンを終えずに終わるまで見届ける");
    expect(codex).toContain("autopilot-run status");
  });
});

describe("担当の切り替えの約束", () => {
  const roles = assignRoles({ level: "high" }, {});
  const cfg = { ...pipelineConfig(roles.implement, roles.reviewers), ...roles };

  test("通常は実装 agy、レビュー claude。同じ CLI の独立したレビューも指定できる", () => {
    expect(roles.implement.chain[0]!.agent).toBe("agy");
    expect(roles.reviewers).toHaveLength(1);
    expect(roles.reviewers[0]!.chain[0]!.agent).toBe("claude");
    expect(AGENTS).toEqual(["claude", "agy", "codex"]);
  });

  test("レビュー担当には 1 行目判定を強制し、コードを変更させない", () => {
    const text = prompts.review({
      baseSha: "abc",
      since: null,
      specPath: ".autopilot/request.md",
    });
    expect(text).toContain("あなたはコードレビュアーである。ファイルは一切変更しない");
    expect(text).toContain(`「${prompts.VERDICT.must}」か「${prompts.VERDICT.none}」`);
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
