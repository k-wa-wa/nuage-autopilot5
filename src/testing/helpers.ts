import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentName, Invocation } from "../agents.ts";
import type { CheckBucket, PrSnapshot } from "../ci.ts";
import type { GitHub } from "../github.ts";
import type { Assignee } from "../models.ts";
import type { Config, Deps } from "../pipeline.ts";

/**
 * プロンプトの種類を見分ける目印。偽のエージェントはこれで自分の役割を知る。
 * prompts.test.ts が、各プロンプトに目印が入っていることを保証する。
 */
export const MARKERS = {
  implement: "brief.md の仕様を実装",
  review: "あなたはコードレビュアー",
  fix: "直すべきもの",
  summarize: "要約を .autopilot/result.md に書く",
} as const;
export type PromptKind = keyof typeof MARKERS;

export function kindOf(prompt: string): PromptKind {
  for (const [kind, marker] of Object.entries(MARKERS)) {
    if (prompt.includes(marker)) return kind as PromptKind;
  }
  throw new Error(`種類の分からないプロンプト: ${prompt.slice(0, 80)}`);
}

// ---------------------------------------------------------------------------
// pipeline の単体テスト用

export interface HarnessOptions {
  /** 実装・修正の各ターンで commit するか。順に消費する。 */
  commits: boolean[];
  github?: {
    pr: number | null;
    /** CI の状態を読むたびに返すもの。順に消費し、最後の 1 つを繰り返す。 */
    snapshots?: Array<(localHead: string) => PrSnapshot | null>;
  };
  inbox?: boolean;
  failAgent?: (inv: Invocation, kind: PromptKind) => boolean;
  /** 失敗する前に作業ツリーを書き換えるか（途中まで書いて落ちた担当）。 */
  dirtyOnFail?: (inv: Invocation, kind: PromptKind) => boolean;
}

/** エージェント・git・GitHub・時計をすべて偽物にした pipeline の依存。 */
export function pipelineHarness(opts: HarnessOptions) {
  let head = 0;
  let dirty = 0;
  let now = 0;
  const calls: { inv: Invocation; kind: PromptKind; prompt: string; output?: string }[] = [];
  const stages: string[] = [];
  const logs: string[] = [];
  const savedLogs: string[] = [];
  let inbox = opts.inbox ?? false;
  const commits = [...opts.commits];
  const snapshots = [...(opts.github?.snapshots ?? [])];

  const github: GitHub | null = opts.github
    ? {
        prNumber: async () => opts.github?.pr ?? null,
        snapshot: async () => {
          const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
          const snap = next ? next(`sha${head}`) : passing(`sha${head}`);
          if (snap === null) throw new Error("GitHub を読めない");
          return snap;
        },
        saveFailedLog: async (sha) => {
          savedLogs.push(sha);
        },
      }
    : null;

  const deps: Deps = {
    async runAgent(inv, prompt, output) {
      const kind = kindOf(prompt);
      calls.push({ inv, kind, prompt, output });
      if (opts.failAgent?.(inv, kind)) {
        if (opts.dirtyOnFail?.(inv, kind)) dirty++;
        return false;
      }
      if ((kind === "implement" || kind === "fix") && commits.shift()) head++;
      return true;
    },
    head: async () => `sha${head}`,
    fingerprint: async () => `sha${head}+${dirty}`,
    github,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    state: {
      stage: (s) => stages.push(s),
      log: (m) => logs.push(m),
      rel: (n) => `.autopilot/${n}`,
      file: (n) => `/tmp/${n}`,
      takeInbox: (round) => {
        if (!inbox) return null;
        inbox = false;
        return `inbox-${round}.md`;
      },
    },
  };
  return { deps, calls, stages, logs, savedLogs, elapsed: () => now };
}

/** モデルを決め打ちしない担当。 */
export function assignee(agent: AgentName, ...models: string[]): Assignee {
  const chain = models.length > 0 ? models.map((model) => ({ agent, model })) : [{ agent }];
  return { name: models.length > 0 ? `${agent}:${models.join("/")}` : agent, chain };
}

/** 実装・修正・要約を impl が、レビューを reviewers が行う設定。 */
export function pipelineConfig(
  impl: Assignee,
  reviewers: Assignee[],
  extra: Partial<Config> = {},
): Config {
  return {
    implement: impl,
    fix: impl,
    summarize: impl,
    reviewers,
    maxRounds: 3,
    baseSha: "sha0",
    ...extra,
  };
}

export function passing(head: string): PrSnapshot {
  return { head, checks: ["pass"] };
}

export function checks(...buckets: CheckBucket[]) {
  return (head: string): PrSnapshot => ({ head, checks: buckets });
}

// ---------------------------------------------------------------------------
// 一時ディレクトリと git

export function tempDir(prefix = "autopilot-test-"): { path: string; cleanup: () => void } {
  // macOS の /var は /private/var への symlink。git の出力と比べるため実体に揃える。
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/**
 * bare の origin と、そこから clone した作業コピーを作る。
 * 作業コピーは branch に乗せる（既定ブランチは main）。
 */
export function tempRepo(branch = "feat/x") {
  const dir = tempDir();
  const origin = join(dir.path, "origin.git");
  const work = join(dir.path, "work");
  git(dir.path, "init", "--bare", "-b", "main", origin);
  git(dir.path, "clone", "-q", origin, work);
  writeFileSync(join(work, "README.md"), "hello\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "init");
  git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "remote", "set-head", "origin", "main");
  if (branch !== "main") git(work, "switch", "-qc", branch);
  return { root: dir.path, origin, work, cleanup: dir.cleanup };
}

// ---------------------------------------------------------------------------
// 偽のエージェント CLI と gh（エンドツーエンドのテスト用）

/**
 * 偽のエージェントが各ターンで行うこと。
 * - commit: ファイルを足して commit する（.autopilot/ も含めて git add -A する）
 * - push / pr: git push / gh pr create
 * - result: .autopilot/result.md を書く
 * - fail: 異常終了する
 * - fail-if-model:M: --model M で呼ばれたら異常終了する（利用上限に達したモデル）
 * - hang: 孫プロセスを起動して終わらない（停止のテスト用）
 * - それ以外の文字列: 標準出力に書く
 */
export type Action =
  | "commit"
  | "push"
  | "pr"
  | "result"
  | "fail"
  | "hang"
  | `say:${string}`
  | `fail-if-model:${string}`;

/** エージェント名 → 種類 → 行動。配列の配列なら呼ばれるたびに順に使い、最後を繰り返す。 */
export type AgentScripts = Record<string, Partial<Record<PromptKind, Action[] | Action[][]>>>;

export interface FakeWorld {
  bin: string;
  stateDir: string;
  /** 偽の CLI に渡す設定を書く。 */
  scripts(s: AgentScripts): void;
  /** gh pr checks が返す CI の状態。呼ばれるたびに順に使い、最後を繰り返す。省略時は CI 無し。 */
  checks(seq: CheckBucket[][]): void;
  /** 偽の CLI が呼ばれた記録。 */
  calls(): { name: string; kind: PromptKind; prompt: string; args: string[]; orca: string[] }[];
  ghLog(): string[];
}

const FAKE_AGENT = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.FAKE_STATE;
const name = NAME;
const prompt = process.argv.at(-1);
const markers = JSON.parse(process.env.FAKE_MARKERS);
const kind = Object.keys(markers).find((k) => prompt.includes(markers[k]));
const args = process.argv.slice(2, -1);
appendFileSync(join(state, "calls.jsonl"), JSON.stringify({
  name, kind, prompt, args, orca: Object.keys(process.env).filter((k) => k.startsWith("ORCA_")),
}) + "\\n");
const scripts = existsSync(join(state, "scripts.json")) ? JSON.parse(readFileSync(join(state, "scripts.json"), "utf8")) : {};
let actions = scripts[name]?.[kind] ?? [];
if (Array.isArray(actions[0])) {
  const counter = join(state, "count-" + name + "-" + kind);
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  actions = actions[Math.min(n, actions.length - 1)];
}
const sh = (...args) => {
  const r = Bun.spawnSync(args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
};
for (const a of actions) {
  if (a === "commit") {
    const f = "work-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".txt";
    writeFileSync(f, name + " " + kind + "\\n");
    sh("git", "add", "-A");
    sh("git", "commit", "-qm", name + " " + kind);
  } else if (a === "push") sh("git", "push", "-q", "origin", "HEAD");
  else if (a === "pr") sh("gh", "pr", "create", "--fill");
  else if (a === "result") writeFileSync(".autopilot/result.md", "要約\\n");
  else if (a === "fail") process.exit(3);
  else if (a.startsWith("fail-if-model:")) {
    const i = args.indexOf("--model");
    if (i !== -1 && args[i + 1] === a.slice("fail-if-model:".length)) process.exit(3);
  }
  else if (a === "hang") {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 600000)"]);
    writeFileSync(join(state, "grandchild.pid"), String(child.pid));
    await new Promise(() => {});
  } else if (a.startsWith("say:")) console.log(a.slice(4));
}
`;

const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.FAKE_STATE;
const args = process.argv.slice(2);
appendFileSync(join(state, "gh.log"), args.join(" ") + "\\n");
const has = (...xs) => xs.every((x) => args.includes(x));
const out = (s) => { console.log(s); process.exit(0); };
const fail = (s) => { console.error(s); process.exit(1); };
const prFile = join(state, "pr");
const git = (...a) => Bun.spawnSync(["git", ...a]).stdout.toString().trim();

if (has("repo", "view")) out("main");
if (has("pr", "create")) { writeFileSync(prFile, "7"); out("https://github.com/o/r/pull/7"); }
if (has("pr", "edit")) out("");
if (has("pr", "view", "number")) existsSync(prFile) ? out(readFileSync(prFile, "utf8")) : fail("no pull requests found");
if (has("pr", "view", "headRefOid")) {
  const ref = "refs/heads/" + git("branch", "--show-current");
  out(git("ls-remote", "origin", ref).split("\\t")[0]);
}
if (has("pr", "checks")) {
  const f = join(state, "checks.json");
  if (!existsSync(f)) fail("no checks reported on the 'x' branch");
  const seq = JSON.parse(readFileSync(f, "utf8"));
  const counter = join(state, "count-checks");
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  const now = seq[Math.min(n, seq.length - 1)];
  out(JSON.stringify(now.map((bucket) => ({ bucket }))));
}
if (has("run", "list")) out("123");
if (has("run", "view")) out("Error: test failed");
fail("fake gh: 未対応の呼び出し: " + args.join(" "));
`;

/** 偽の claude / agy / copilot / gh と本物の git だけを置いた bin を作る。 */
export function fakeWorld(root: string, agents: readonly string[] = ["claude", "agy"]): FakeWorld {
  const bin = join(root, "bin");
  const stateDir = join(root, "fake");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // symlink にすると bun が実体のパスに解決して名前が分からなくなるので、名前ごとに書く。
  // env を経由せず、テストを動かしている bun で直接動かす（nix のサンドボックスには /usr/bin/env が無い）。
  const write = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\n${body}`);
    chmodSync(path, 0o755);
  };
  for (const a of agents) write(a, `const NAME = ${JSON.stringify(a)};\n${FAKE_AGENT}`);
  write("gh", FAKE_GH);
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git が無い");
  symlinkSync(realGit, join(bin, "git"));

  const readLines = (name: string): string[] => {
    const path = join(stateDir, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
  };
  return {
    bin,
    stateDir,
    scripts: (s) => writeFileSync(join(stateDir, "scripts.json"), JSON.stringify(s)),
    checks: (seq) => writeFileSync(join(stateDir, "checks.json"), JSON.stringify(seq)),
    calls: () => readLines("calls.jsonl").map((l) => JSON.parse(l)),
    ghLog: () => readLines("gh.log"),
  };
}

const MAIN = join(import.meta.dir, "..", "main.ts");

/** autopilot-run を別プロセスで動かす。PATH は偽の bin と /bin（sh）だけにする。 */
export function spawnMain(
  args: string[],
  opts: { cwd: string; world: FakeWorld; home: string; env?: Record<string, string> },
) {
  return Bun.spawn([process.execPath, MAIN, ...args], {
    cwd: opts.cwd,
    env: {
      ...GIT_ENV,
      HOME: opts.home,
      PATH: `${opts.world.bin}:/bin`,
      FAKE_STATE: opts.world.stateDir,
      FAKE_MARKERS: JSON.stringify(MARKERS),
      // ホストの /etc/autopilot5/models.yaml を読まない。テストが置いたときだけ使う。
      AUTOPILOT_MODELS: join(opts.home, "models.yaml"),
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function runMain(
  args: string[],
  opts: Parameters<typeof spawnMain>[1],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = spawnMain(args, opts);
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}
