#!/usr/bin/env bun
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  AGENTS,
  type AgentSpec,
  buildArgv,
  formatAgentSpec,
  formatInvocation,
  parseAgentSpec,
} from "./agents.ts";
import { capture, killAll, run } from "./exec.ts";
import {
  currentBranch,
  defaultBranch,
  gitCommonDir,
  gitToplevel,
  headSha,
  realGitHub,
  resolveBaseSha,
  worktreeFingerprint,
} from "./github.ts";
import {
  type Assignee,
  assignRoles,
  DEFAULT_LEVEL,
  formatModelTable,
  LEVELS,
  type Level,
  loadModelTable,
  MODELS_PATH,
  type ModelTable,
} from "./models.ts";
import { formatOutcome, runPipeline, START_POINTS, type StartPoint } from "./pipeline.ts";
import { STATE_DIR, State } from "./state.ts";

const USAGE = `usage: autopilot-run [start] [--impl AGENT] [--reviewers A,B] [--level LEVEL] [--max-rounds N] [--local] [--from FROM]
       autopilot-run status
       autopilot-run stop
       autopilot-run models [--file PATH]

  AGENT        ${AGENTS.join(" | ")}（既定: claude）。
               モデルは models.yaml の並びを使う。決め打ちするときは AGENT:MODEL@EFFORT/MODEL と書く（/ の順に試す）
  --reviewers  レビュー担当（既定: 実装担当以外で PATH にあるもの全部）
  --level      実装と修正の賢さ。${LEVELS.join(" | ")}（既定: ${DEFAULT_LEVEL}）。レビューは high、要約は light で固定
  --max-rounds 修正ループの上限（1〜10、既定: 3）
  --local      push・PR・CI を行わず、ローカルの差分だけで回す（試運転用）
  --from       どこから始めるか。${START_POINTS.join(" | ")}（既定: implement）。
               review は実装を飛ばし、今のブランチの PR（--local ならローカルの commit）のレビューから始める
  models       段階ごとのモデルの並びを表示する。--file で別のファイルを検査する

  models.yaml  $AUTOPILOT_MODELS（既定: ${MODELS_PATH}）。無ければ各 CLI の既定モデルで動く`;

const modelsPath = () => process.env.AUTOPILOT_MODELS || MODELS_PATH;

/** models.yaml を読む。書き間違いは起動前に拒否する。 */
function readModels(path: string): ModelTable | null {
  try {
    return loadModelTable(path);
  } catch (e) {
    throw new UsageError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 起動を拒否する理由。使い方の誤りなので終了コード 2 で返す。 */
class UsageError extends Error {}

export interface StartOptions {
  impl: AgentSpec;
  reviewers: AgentSpec[];
  level: Level;
  maxRounds: number;
  local: boolean;
  from: StartPoint;
}

/** 引数を読み、起動してよいかを確かめる。PATH の探索は findAgent に任せる。 */
export async function parseStartOptions(
  values: {
    impl: string;
    reviewers?: string;
    level?: string;
    "max-rounds": string;
    local: boolean;
    from?: string;
  },
  findAgent: (name: string) => Promise<boolean>,
): Promise<StartOptions> {
  let impl: AgentSpec;
  let explicit: AgentSpec[] | null = null;
  try {
    impl = parseAgentSpec(values.impl);
    if (values.reviewers) explicit = values.reviewers.split(",").map(parseAgentSpec);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }

  const level = (values.level ?? DEFAULT_LEVEL) as Level;
  if (!LEVELS.includes(level)) {
    throw new UsageError(`--level は ${LEVELS.join(" / ")} のどれか: ${values.level}`);
  }

  const maxRounds = Number(values["max-rounds"]);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
    throw new UsageError(`--max-rounds は 1〜10 の整数: ${values["max-rounds"]}`);
  }

  const from = (values.from ?? "implement") as StartPoint;
  if (!START_POINTS.includes(from)) {
    throw new UsageError(`--from は ${START_POINTS.join(" / ")} のどれか: ${values.from}`);
  }

  let reviewers: AgentSpec[];
  if (explicit) {
    const names = explicit.map(formatAgentSpec);
    if (new Set(names).size !== names.length) {
      throw new UsageError(`--reviewers が重複している: ${names.join(",")}`);
    }
    reviewers = explicit;
  } else {
    reviewers = [];
    for (const agent of AGENTS) {
      if (agent !== impl.agent && (await findAgent(agent))) reviewers.push({ agent, models: [] });
    }
  }
  if (reviewers.length === 0) {
    throw new UsageError(
      `レビュー担当がいない。--reviewers で指定するか、${impl.agent} 以外のエージェント CLI を PATH に入れる`,
    );
  }
  return { impl, reviewers, level, maxRounds, local: values.local, from };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      impl: { type: "string", default: "claude" },
      reviewers: { type: "string" },
      level: { type: "string" },
      "max-rounds": { type: "string", default: "3" },
      file: { type: "string" },
      local: { type: "boolean", default: false },
      from: { type: "string", default: "implement" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  // models は worktree の外（nix のビルドでの検査）でも動かす。
  if (positionals[0] === "models") {
    const path = values.file ?? modelsPath();
    const table = readModels(path);
    if (!table) {
      if (values.file) throw new UsageError(`${path} が無い`);
      console.log(`${path} が無い。各 CLI の既定モデルで動く`);
      return 0;
    }
    console.log(`${path}\n${formatModelTable(table)}`);
    return 0;
  }

  const root = await gitToplevel(process.cwd());
  if (!root) throw new UsageError("git の worktree 内で実行すること");
  const state = new State(root);

  switch (positionals[0] ?? "start") {
    case "status": {
      const pid = state.runningPid();
      console.log(`status: ${state.status()}\nrunning: ${pid ?? "no"}`);
      return 0;
    }
    case "stop": {
      const pid = state.runningPid();
      if (!pid) {
        console.log("実行中ではない");
        return 0;
      }
      process.kill(pid, "SIGTERM");
      console.log(`停止した (pid ${pid})`);
      return 0;
    }
    case "start":
      break;
    default:
      throw new UsageError(USAGE);
  }

  if (!state.read("brief.md")?.trim()) throw new UsageError(`${state.rel("brief.md")} が無い`);
  const running = state.runningPid();
  if (running) {
    console.error(`すでに実行中 (pid ${running})`);
    return 1;
  }

  const opts = await parseStartOptions(
    values,
    async (name) => (await capture(["sh", "-c", `command -v ${name}`], root)).code === 0,
  );
  const models = readModels(modelsPath());

  // 既定ブランチへの直接 commit は、ブランチ保護の有無に関わらず起こさせない。
  const branch = await currentBranch(root);
  if (!branch) throw new UsageError("ブランチに乗っていない（detached HEAD）");
  // PR モードでは gh の認証とリポジトリへのアクセスもここで確かめ、だめなら実装担当を起動する前に止める。
  let base: string | null;
  try {
    base = await defaultBranch(root, opts.local);
  } catch (e) {
    throw new UsageError(`GitHub を読めない: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (branch === base) {
    throw new UsageError(`既定ブランチ (${base}) の上では動かさない。作業ブランチを切ること`);
  }

  await excludeStateDir(root);
  writeFileSync(state.file("run.pid"), String(process.pid));
  // 前回の要約を窓口が読み違えないよう、始める前に消す。
  rmSync(state.file("result.md"), { force: true });

  const stop = () => {
    killAll();
    state.stage("stopped: 人間が停止した");
    rmSync(state.file("run.pid"), { force: true });
    process.exit(143);
  };
  // stop サブコマンドは SIGTERM。窓口のセッションが閉じたときは SIGHUP が来る。
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, stop);

  try {
    const outcome = await start(state, root, base, opts, models);
    state.stage(formatOutcome(outcome));
    return outcome.kind === "failed" ? 1 : 0;
  } catch (e) {
    state.stage(`failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    if (!existsSync(state.file("result.md"))) {
      writeFileSync(
        state.file("result.md"),
        `要約は書かれなかった。結果: ${state.status()}\n詳細は ${state.rel("run.log")} を読むこと。\n`,
      );
    }
    rmSync(state.file("run.pid"), { force: true });
  }
}

async function start(
  state: State,
  root: string,
  base: string | null,
  opts: StartOptions,
  models: ModelTable | null,
) {
  const logPath = state.file("run.log");
  const baseSha = await resolveBaseSha(root, base);
  state.log(
    `start impl=${formatAgentSpec(opts.impl)} level=${opts.level} reviewers=${opts.reviewers.map(formatAgentSpec).join(",")} base=${baseSha.slice(0, 8)} from=${opts.from}${opts.local ? " (local)" : ""}`,
  );
  if (!models) state.log(`${modelsPath()} が無いので、各 CLI の既定モデルで動く`);
  const roles = assignRoles(opts, models ?? {});
  const chain = (a: Assignee) => a.chain.map(formatInvocation).join(" → ");
  state.log(
    [
      `models: implement=${chain(roles.implement)}`,
      `summarize=${chain(roles.summarize)}`,
      ...roles.reviewers.map((r) => `review(${r.name})=${chain(r)}`),
    ].join(" "),
  );

  return runPipeline(
    { ...roles, maxRounds: opts.maxRounds, baseSha, from: opts.from },
    {
      async runAgent(inv, prompt, outputName) {
        state.log(`-> ${formatInvocation(inv)}`);
        const r = await run(buildArgv(inv, prompt), {
          cwd: root,
          logPath,
          stdoutPath: outputName ? state.file(outputName) : undefined,
        });
        return r.code === 0;
      },
      head: () => headSha(root),
      fingerprint: () => worktreeFingerprint(root),
      github: opts.local ? null : realGitHub(root),
      clock: { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
      state,
    },
  );
}

/** .autopilot/ をコミットさせない。worktree 共通の exclude に書く。 */
async function excludeStateDir(cwd: string): Promise<void> {
  const path = `${await gitCommonDir(cwd)}/info/exclude`;
  const line = `${STATE_DIR}/`;
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!current.split("\n").includes(line))
    appendFileSync(path, `${current.endsWith("\n") || !current ? "" : "\n"}${line}\n`);
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof UsageError) {
        console.error(e.message);
        process.exit(2);
      }
      console.error(e);
      process.exit(1);
    },
  );
}
