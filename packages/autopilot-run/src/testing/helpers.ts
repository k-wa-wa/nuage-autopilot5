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
import type { AgentName, FailureKind, Invocation } from "../agents.ts";
import type { CheckBucket, PrSnapshot } from "../ci.ts";
import type { GateFile, GitHub } from "../github.ts";
import type { Assignee, ReviewerAssignee } from "../models.ts";
import type { Config, Deps, SessionPlan } from "../pipeline.ts";
import { GATE_VERDICT, REVIEW_PERSPECTIVES, VERDICT } from "../prompts.ts";

/**
 * プロンプトの種類を見分ける目印。偽のエージェントはこれで自分の役割を知る。
 * prompts.test.ts が、各プロンプトに目印が入っていることを保証する。
 */
export const MARKERS = {
  implement: "brief.md の仕様を実装",
  review: "あなたはコードレビュアー",
  fix: "直すべきもの",
  gate: "リポジトリのゲート検証担当",
  summarize: "要約を .autopilot/result.md に書く",
} as const;
export type PromptKind = keyof typeof MARKERS;

export function kindOf(prompt: string): PromptKind {
  for (const [kind, marker] of Object.entries(MARKERS)) {
    if (prompt.includes(marker)) return kind as PromptKind;
  }
  throw new Error(`種類の分からないプロンプト: ${prompt.slice(0, 80)}`);
}

/** gh 2.101 の実物の stderr。PR が無いとき（exit 1）。 */
export const GH_NO_PR = 'no pull requests found for branch "bot-wa-wa/fix-resume-review"';

/** gh 2.101 の実物の stderr。認証が無いとき（exit 4。gh pr view・gh repo view とも）。 */
export const GH_NO_AUTH = `To get started with GitHub CLI, please run:  gh auth login
Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.`;

/** Claude Code 2.1.322 のバイナリで確認した上限・認証エラーの文言。
 * 実在のモデル名は置かず、表示名だけ MODEL に置き換える。
 */
export const CLAUDE_UNAVAILABLE_MESSAGES = [
  "You've hit your session limit · resets 3pm",
  "You've hit your weekly limit",
  "You've hit your 5-hour limit",
  "MODEL limit reached · resets 5pm",
  "you have reached your weekly usage limit",
  "You've hit your monthly spend limit",
  "Your credit balance is too low to access the Anthropic API",
  "Context limit reached",
  "Invalid API key · Please run /login",
];

/** codex-cli 0.167.1 のバイナリで確認した文言。上限の実発生時の記録ではない。 */
export const CODEX_UNAVAILABLE_MESSAGES = [
  "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
  "Your access token could not be refreshed. Please log out and sign in again.",
  "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
];

/** 親が先頭 1 バイトを処理したことをログで確認してから、UTF-8 文字の残りを出す子。 */
export function splitUtf8Script(stdoutPath: string, logPath: string, text: string): string {
  return `
    const { existsSync, statSync } = require("node:fs");
    const paths = ${JSON.stringify([stdoutPath, logPath])};
    const bytes = Buffer.from(${JSON.stringify(text)});
    process.stdout.write(bytes.subarray(0, 1));
    process.stderr.write(bytes.subarray(0, 1));
    const deadline = Date.now() + 3000;
    while (!paths.every((p) => existsSync(p) && statSync(p).size > 0)) {
      if (Date.now() > deadline) process.exit(2);
      await Bun.sleep(5);
    }
    process.stdout.write(bytes.subarray(1));
    process.stderr.write(bytes.subarray(1));
  `;
}

// ---------------------------------------------------------------------------
// pipeline の単体テスト用

export interface HarnessOptions {
  /** 実装・修正の各ターンで commit するか。順に消費する。 */
  commits: boolean[];
  /** 始める前に基点（sha0）から進んでいる commit の数。既存の PR の続きを表す。 */
  startHead?: number;
  github?: {
    pr: number | null;
    /** CI の状態を読むたびに返すもの。順に消費し、最後の 1 つを繰り返す。 */
    snapshots?: Array<(localHead: string) => PrSnapshot | null>;
  };
  inbox?: boolean;
  failure?: FailureKind;
  failAgent?: (inv: Invocation, kind: PromptKind) => boolean;
  /** 失敗する前に作業ツリーを書き換えるか（途中まで書いて落ちた担当）。 */
  dirtyOnFail?: (inv: Invocation, kind: PromptKind) => boolean;
  /** レビューの本文。省略時は must あり（指摘を直せば再レビューする、今までどおりの流れ）。 */
  review?: (round: number, reviewer: string) => string;
  /** ゲートの手順書一覧。省略時は空（ゲートなし）。 */
  gates?:
    | Array<{ name: string; path?: string; content?: string }>
    | ((baseSha: string) => Promise<GateFile[]> | GateFile[]);
  /** ゲートの実行結果本文。省略時は合格。 */
  gate?: (round: number, gateName: string) => string;
  /** 会話 ID を返さないエージェント（出力を読めなかったとき）。 */
  noSession?: boolean;
}

/** エージェント・git・GitHub・時計をすべて偽物にした pipeline の依存。 */
export function pipelineHarness(opts: HarnessOptions) {
  let head = opts.startHead ?? 0;
  let dirty = 0;
  let now = 0;
  const calls: {
    inv: Invocation;
    kind: PromptKind;
    prompt: string;
    output?: string;
    session?: SessionPlan;
    /** 呼ばれた時刻（偽の時計）。 */
    at: number;
  }[] = [];
  let conversations = 0;
  const stages: string[] = [];
  const logs: string[] = [];
  const savedLogs: string[] = [];
  const inbox = opts.inbox ?? false;
  let inboxTaken = false;
  const commits = [...opts.commits];
  const snapshots = [...(opts.github?.snapshots ?? [])];
  const storedFiles = new Map<string, string>();

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
    async runAgent(inv, prompt, { output, session } = {}) {
      const kind = kindOf(prompt);
      calls.push({ inv, kind, prompt, output, session, at: now });
      if (opts.failAgent?.(inv, kind)) {
        if (opts.dirtyOnFail?.(inv, kind)) dirty++;
        return { ok: false, session: null, failure: opts.failure ?? "unavailable" };
      }
      if ((kind === "implement" || kind === "fix") && commits.shift()) head++;
      const id = !session
        ? null
        : session.kind === "resume"
          ? session.id
          : `conv${++conversations}`;
      return { ok: true, session: opts.noSession ? null : id };
    },
    head: async () => `sha${head}`,
    fingerprint: async () => `sha${head}+${dirty}`,
    findGates: async (baseSha) => {
      if (typeof opts.gates === "function") {
        return opts.gates(baseSha);
      }
      if (Array.isArray(opts.gates)) {
        return opts.gates.map((g) => ({
          name: g.name,
          path: g.path ?? `.agents/autopilot-gate-${g.name}.md`,
          content: g.content ?? `# ゲート ${g.name}`,
        }));
      }
      return [];
    },
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
      read: (n) => {
        const stored = storedFiles.get(n);
        if (stored !== undefined) return stored;
        const mRev = n.match(/^review-(\d+)-(.+)\.md$/);
        if (mRev) {
          const initial = (opts.review ?? (() => `${VERDICT.must}\n- must: 直す`))(
            Number(mRev[1]),
            mRev[2]!,
          );
          storedFiles.set(n, initial);
          return initial;
        }
        const mGate = n.match(/^gate-(\d+)-(.+)\.md$/);
        if (mGate) {
          const initial = (opts.gate ?? (() => `${GATE_VERDICT.pass}\n確かめて問題なし`))(
            Number(mGate[1]),
            mGate[2]!,
          );
          storedFiles.set(n, initial);
          return initial;
        }
        return null;
      },
      write: (n, text) => {
        storedFiles.set(n, text);
      },
      append: (n, text) => {
        const cur = deps.state.read(n) ?? "";
        storedFiles.set(n, cur + text);
      },
      takeInbox: (round) => {
        if (!inbox || inboxTaken) return null;
        inboxTaken = true;
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
  const reviewerAssignees: ReviewerAssignee[] = REVIEW_PERSPECTIVES.map((p, i) => {
    const r = reviewers[i % reviewers.length]!;
    return {
      ...r,
      perspective: p.slug,
    };
  });
  return {
    implement: impl,
    fix: impl,
    summarize: impl,
    reviewers: reviewerAssignees,
    gate: reviewers[0] ?? impl,
    maxRounds: 3,
    baseSha: "sha0",
    from: "implement",
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
  | "unavailable"
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
  /** 今のブランチに PR #n がすでにある状態にする（既存の PR の続き）。 */
  openPr(n: number): void;
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
// --output-format json（agy の会話を引き継ぐ実行）では、本文を JSON に包み、会話 ID を返す。
const json = args.includes("--output-format") || args.includes("--json");
const said = [];
const conv = name === "codex" ? (args.includes("resume") ? args.at(-2) : "codex-conv-1") : args.includes("--conversation") ? args[args.indexOf("--conversation") + 1] : "agy-conv-1";
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
  else if (a === "unavailable") { console.error("Rate limit exceeded"); process.exit(3); }
  else if (a.startsWith("fail-if-model:")) {
    const i = args.indexOf("--model");
    if (i !== -1 && args[i + 1] === a.slice("fail-if-model:".length)) { console.error("Rate limit exceeded"); process.exit(3); }
  }
  else if (a === "hang") {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 600000)"]);
    writeFileSync(join(state, "grandchild.pid"), String(child.pid));
    await new Promise(() => {});
  } else if (a.startsWith("say:")) json ? said.push(a.slice(4)) : console.log(a.slice(4));
}
if (name === "codex") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: conv }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: said.join("\\n") } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
} else if (json) console.log(JSON.stringify({ conversation_id: conv, status: "SUCCESS", response: said.join("\\n") }));
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

// 認証の無いシェルから起動したとき。gh 2.101 の実物の出力。
if (process.env.FAKE_GH_NO_AUTH) { console.error(GH_NO_AUTH); process.exit(4); }
if (has("repo", "view")) out("main");
if (has("pr", "create")) { writeFileSync(prFile, "7"); out("https://github.com/o/r/pull/7"); }
if (has("pr", "edit")) out("");
if (has("pr", "view", "number")) existsSync(prFile) ? out(readFileSync(prFile, "utf8")) : fail('no pull requests found for branch "' + git("branch", "--show-current") + '"');
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

const MAIN = join(import.meta.dir, "..", "main.ts");

/** 偽の claude / agy / codex / gh と本物の git だけを置いた bin を作る。 */
export function fakeWorld(
  root: string,
  agents: readonly string[] = ["claude", "agy", "codex"],
): FakeWorld {
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
  write("gh", `const GH_NO_AUTH = ${JSON.stringify(GH_NO_AUTH)};\n${FAKE_GH}`);
  write("autopilot-run", `import "${MAIN}";\n`);
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git が無い");
  symlinkSync(realGit, join(bin, "git"));
  const realGitleaks = Bun.which("gitleaks");
  if (!realGitleaks) throw new Error("gitleaks が無い");
  symlinkSync(realGitleaks, join(bin, "gitleaks"));

  const readLines = (name: string): string[] => {
    const path = join(stateDir, name);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
  };
  return {
    bin,
    stateDir,
    scripts: (s) => writeFileSync(join(stateDir, "scripts.json"), JSON.stringify(s)),
    checks: (seq) => writeFileSync(join(stateDir, "checks.json"), JSON.stringify(seq)),
    openPr: (n) => writeFileSync(join(stateDir, "pr"), String(n)),
    calls: () => readLines("calls.jsonl").map((l) => JSON.parse(l)),
    ghLog: () => readLines("gh.log"),
  };
}

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
