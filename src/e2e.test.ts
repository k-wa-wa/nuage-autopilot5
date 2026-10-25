import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeWorld, fakeWorld, git, runMain, spawnMain, tempRepo } from "./testing/helpers.ts";

/**
 * autopilot-run を別プロセスで丸ごと動かすテスト。
 * 本物の git（origin は bare リポジトリ）と、偽の claude / agy / gh を使う。
 */

const TIMEOUT = 30_000;

interface Env {
  repo: ReturnType<typeof tempRepo>;
  world: FakeWorld;
  home: string;
  dir: string;
}

let env: Env;
afterEach(() => env?.repo.cleanup());

function setup(opts: { branch?: string; brief?: boolean; agents?: string[] } = {}): Env {
  const repo = tempRepo(opts.branch);
  const world = fakeWorld(repo.root, opts.agents);
  const home = join(repo.root, "home");
  mkdirSync(home);
  const dir = join(repo.work, ".autopilot");
  if (opts.brief !== false) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "brief.md"), "# 目的\nREADME に一行足す\n");
  }
  env = { repo, world, home, dir };
  return env;
}

const main = (args: string[], extra: Record<string, string> = {}) =>
  runMain(args, { cwd: env.repo.work, world: env.world, home: env.home, env: extra });

const read = (name: string) => readFileSync(join(env.dir, name), "utf8");
const status = () => read("status").trim();

describe("--local", () => {
  test(
    "実装 → レビュー → 要約まで進み、done で終わる",
    async () => {
      setup();
      env.world.scripts({
        claude: { implement: ["commit"], fix: [], summarize: ["result"] },
        agy: { review: ["say:指摘なし"] },
      });
      const r = await main(["--local"], { ORCA_PANE_KEY: "pane", ORCA_AGENT_HOOK_PORT: "1" });
      expect(r.code).toBe(0);
      expect(status()).toBe("done");
      expect(read("result.md")).toBe("要約\n");
      expect(read("review-1-agy.md")).toBe("指摘なし\n");
      expect(env.world.calls().map((c) => `${c.name}:${c.kind}`)).toEqual([
        "claude:implement",
        "agy:review",
        "claude:fix",
        "claude:summarize",
      ]);
      expect(existsSync(join(env.dir, "run.pid"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "裏のエージェントには ORCA_* を渡さない（窓口に通知が鳴らない）",
    async () => {
      setup();
      env.world.scripts({ claude: { implement: ["commit"] }, agy: { review: ["say:指摘なし"] } });
      await main(["--local"], { ORCA_PANE_KEY: "pane", ORCA_AGENT_HOOK_TOKEN: "t" });
      const calls = env.world.calls();
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.orca).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "エージェントが git add -A しても .autopilot/ はコミットされない",
    async () => {
      setup();
      env.world.scripts({ claude: { implement: ["commit"] }, agy: { review: ["say:指摘なし"] } });
      await main(["--local"]);
      const files = git(env.repo.work, "log", "--name-only", "--format=", "main..HEAD");
      expect(files).toMatch(/work-.*\.txt/);
      expect(files).not.toContain(".autopilot");
    },
    TIMEOUT,
  );

  test(
    "commit されなければ failed で終わり、窓口が読む result.md は残す",
    async () => {
      setup();
      env.world.scripts({ claude: { implement: [] }, agy: { review: ["say:指摘なし"] } });
      const r = await main(["--local"]);
      expect(r.code).toBe(1);
      expect(status()).toBe("failed: 何も commit されなかった");
      expect(read("result.md")).toContain("要約は書かれなかった");
    },
    TIMEOUT,
  );

  test(
    "前回の result.md は始める前に消す（古い要約を報告させない）",
    async () => {
      setup();
      writeFileSync(join(env.dir, "result.md"), "前回の要約\n");
      env.world.scripts({ claude: { implement: [] }, agy: { review: ["say:指摘なし"] } });
      await main(["--local"]);
      expect(read("result.md")).not.toContain("前回の要約");
    },
    TIMEOUT,
  );
});

describe("起動前の確認", () => {
  test(
    "brief.md が無ければ起動しない",
    async () => {
      setup({ brief: false });
      const r = await main(["--local"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("brief.md");
      expect(env.world.calls()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "既定ブランチの上では起動しない",
    async () => {
      setup({ branch: "main" });
      const r = await main(["--local"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("既定ブランチ");
      expect(env.world.calls()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "レビュー担当が見つからなければ起動しない",
    async () => {
      setup({ agents: ["claude"] });
      const r = await main(["--local"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("レビュー担当がいない");
    },
    TIMEOUT,
  );

  test(
    "status は実行中でないことと最後の段階を返す",
    async () => {
      setup();
      writeFileSync(join(env.dir, "status"), "done\n");
      const r = await main(["status"]);
      expect(r.stdout).toBe("status: done\nrunning: no\n");
    },
    TIMEOUT,
  );
});

describe("stop", () => {
  test(
    "実行中のエージェントを孫プロセスごと止め、stopped にする",
    async () => {
      setup();
      env.world.scripts({ claude: { implement: ["hang"] }, agy: { review: ["say:指摘なし"] } });
      const p = spawnMain(["--local"], { cwd: env.repo.work, world: env.world, home: env.home });

      const gcFile = join(env.world.stateDir, "grandchild.pid");
      for (let i = 0; i < 200 && !existsSync(gcFile); i++) await Bun.sleep(50);
      const grandchild = Number(readFileSync(gcFile, "utf8"));

      const s = await main(["stop"]);
      expect(s.stdout).toContain("停止した");
      expect(await p.exited).toBe(143);
      expect(status()).toBe("stopped: 人間が停止した");
      expect(existsSync(join(env.dir, "run.pid"))).toBe(false);

      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        try {
          process.kill(grandchild, 0);
          await Bun.sleep(50);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
    TIMEOUT,
  );
});

describe("PR モード", () => {
  test(
    "PR を作り、CI が通ったらレビューして done で終わる",
    async () => {
      setup();
      env.world.scripts({
        claude: { implement: ["commit", "push", "pr"], fix: [], summarize: ["result"] },
        agy: { review: ["say:指摘なし"] },
      });
      env.world.checks([["pass", "skipping"]]);
      const r = await main([]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(status()).toBe("done");
      expect(read("run.log")).toContain("PR #7");
      expect(env.world.ghLog()).toContain("pr checks 7 --json bucket");
    },
    TIMEOUT,
  );

  test(
    "CI が落ちたらログを渡して直させ、次のラウンドで CI を待ち直す",
    async () => {
      setup();
      env.world.scripts({
        claude: {
          implement: ["commit", "push", "pr"],
          fix: [["commit", "push"], []],
          summarize: ["result"],
        },
        agy: { review: ["say:指摘なし"] },
      });
      env.world.checks([["fail"], ["pass"]]);
      const r = await main([]);
      expect(r.code).toBe(0);
      expect(status()).toBe("done");
      expect(read("ci-fail-1.log")).toContain("test failed");
      const fixes = env.world.calls().filter((c) => c.kind === "fix");
      expect(fixes[0]?.prompt).toContain(".autopilot/ci-fail-1.log");
      expect(fixes[1]?.prompt).not.toContain("ci-fail");
      expect(env.world.ghLog().some((l) => l.startsWith("run list --commit "))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "gh の認証が無ければ、実装担当を起動する前に gh の出力を付けて拒否する",
    async () => {
      setup();
      env.world.scripts({ claude: { implement: ["commit"] }, agy: { review: ["say:指摘なし"] } });
      const r = await main([], { FAKE_GH_NO_AUTH: "1" });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("gh auth login");
      expect(env.world.calls()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "PR が作られなければ failed",
    async () => {
      setup();
      env.world.scripts({
        claude: { implement: ["commit", "push"] },
        agy: { review: ["say:指摘なし"] },
      });
      const r = await main([]);
      expect(r.code).toBe(1);
      expect(status()).toBe("failed: PR が作られなかった");
    },
    TIMEOUT,
  );
});

describe("--from review", () => {
  /** 実装は済んでいて、push 済みの commit と PR がある状態。 */
  const implemented = (pr: number | null) => {
    writeFileSync(join(env.repo.work, "done.txt"), "implemented\n");
    git(env.repo.work, "add", "done.txt");
    git(env.repo.work, "commit", "-qm", "implemented");
    git(env.repo.work, "push", "-q", "origin", "HEAD");
    if (pr !== null) env.world.openPr(pr);
  };

  test(
    "既存の PR に対して、実装を飛ばして CI 待ち → レビュー → 要約を行う",
    async () => {
      setup();
      implemented(56);
      env.world.scripts({
        claude: { implement: ["commit"], fix: [], summarize: ["result"] },
        agy: { review: ["say:指摘なし"] },
      });
      env.world.checks([["pass"]]);
      const r = await main(["--from", "review"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(status()).toBe("done");
      expect(read("run.log")).toContain("PR #56");
      expect(env.world.ghLog()).toContain("pr checks 56 --json bucket");
      expect(env.world.calls().map((c) => `${c.name}:${c.kind}`)).toEqual([
        "agy:review",
        "claude:fix",
        "claude:summarize",
      ]);
    },
    TIMEOUT,
  );

  test(
    "PR が無ければ、誰も呼ばずに failed で終わる",
    async () => {
      setup();
      implemented(null);
      env.world.scripts({ claude: { implement: ["commit"] }, agy: { review: ["say:指摘なし"] } });
      const r = await main(["--from", "review"]);
      expect(r.code).toBe(1);
      expect(status()).toBe("failed: PR が無い");
      expect(env.world.calls()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "--local と併せると、PR を使わずにローカルの commit をレビューする",
    async () => {
      setup();
      implemented(null);
      env.world.scripts({
        claude: { implement: ["commit"], fix: [], summarize: ["result"] },
        agy: { review: ["say:指摘なし"] },
      });
      const r = await main(["--from", "review", "--local"]);
      expect(r.code).toBe(0);
      expect(status()).toBe("done");
      expect(env.world.calls().map((c) => `${c.name}:${c.kind}`)).toEqual([
        "agy:review",
        "claude:fix",
        "claude:summarize",
      ]);
      expect(env.world.ghLog()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "知らない値では起動しない",
    async () => {
      setup();
      const r = await main(["--from", "fix"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--from");
      expect(env.world.calls()).toEqual([]);
    },
    TIMEOUT,
  );
});

describe("models.yaml", () => {
  const MODELS = `
claude:
  high: [c1@high, c2@high]
  light: [c-small@low]
agy:
  high: [a1, a2]
`;
  const writeModels = (text = MODELS) => writeFileSync(join(env.home, "models.yaml"), text);
  const invocations = (kind: string) =>
    env.world
      .calls()
      .filter((c) => c.kind === kind)
      .map((c) => `${c.name} ${c.args.join(" ")}`);

  test(
    "作業ごとの段階の並びでモデルと effort を渡し、利用上限のモデルは次へ切り替える",
    async () => {
      setup();
      writeModels();
      env.world.scripts({
        claude: { implement: ["commit"], fix: [], summarize: ["result"] },
        agy: { review: ["fail-if-model:a1", "say:指摘なし"] },
      });
      const r = await main(["--local"]);
      expect(r.code).toBe(0);
      expect(status()).toBe("done");
      expect(invocations("implement")).toEqual([
        "claude --model c1 --effort high --dangerously-skip-permissions -p",
      ]);
      expect(invocations("review")).toEqual([
        "agy --model a1 --dangerously-skip-permissions -p",
        "agy --model a2 --dangerously-skip-permissions -p",
      ]);
      expect(invocations("summarize")).toEqual([
        "claude --model c-small --effort low --dangerously-skip-permissions -p",
      ]);
      expect(read("review-1-agy.md")).toBe("指摘なし\n");
      expect(read("run.log")).toContain("agy:a1 が失敗した。agy:a2 で試し直す");
    },
    TIMEOUT,
  );

  test(
    "実装担当が何も変えずに落ちたら次のモデルで実装し、書き換えてから落ちたら切り替えない",
    async () => {
      setup();
      writeModels();
      env.world.scripts({
        claude: { implement: ["fail-if-model:c1", "commit"], fix: [], summarize: ["result"] },
        agy: { review: ["say:指摘なし"] },
      });
      expect((await main(["--local"])).code).toBe(0);
      expect(invocations("implement").map((l) => l.split(" ")[2])).toEqual(["c1", "c2"]);
      env.repo.cleanup();

      setup();
      writeModels();
      env.world.scripts({
        claude: { implement: ["commit", "fail-if-model:c1"] },
        agy: { review: ["say:指摘なし"] },
      });
      expect((await main(["--local"])).code).toBe(1);
      expect(status()).toBe("failed: 実装担当が異常終了した");
      expect(invocations("implement").map((l) => l.split(" ")[2])).toEqual(["c1"]);
    },
    TIMEOUT,
  );

  test(
    "書き間違えた models.yaml では起動しない",
    async () => {
      setup();
      writeModels("claude:\n  hgih: [c1]\n");
      const r = await main(["--local"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("知らない段階: hgih");
      expect(env.world.calls()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "models は並びを表示し、--file で検査できる（worktree の外でも動く）",
    async () => {
      setup();
      writeModels();
      const shown = await main(["models"]);
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain("a1 → a2");

      const opts = { cwd: env.home, world: env.world, home: env.home };
      const bad = join(env.home, "bad.yaml");
      writeFileSync(bad, "codex:\n  high: [x]\n");
      const checked = await runMain(["models", "--file", bad], opts);
      expect(checked.code).toBe(2);
      expect(checked.stderr).toContain("知らないエージェント: codex");
      const missing = await runMain(["models", "--file", join(env.home, "none.yaml")], opts);
      expect(missing.code).toBe(2);
    },
    TIMEOUT,
  );
});
