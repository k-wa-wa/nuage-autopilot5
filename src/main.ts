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
import { AGENTS, type AgentSpec, buildArgv, formatAgentSpec, parseAgentSpec } from "./agents.ts";
import { capture, killAll, run } from "./exec.ts";
import {
  currentBranch,
  defaultBranch,
  gitCommonDir,
  gitToplevel,
  headSha,
  realGitHub,
  resolveBaseSha,
} from "./github.ts";
import { formatOutcome, runPipeline } from "./pipeline.ts";
import { STATE_DIR, State } from "./state.ts";

const USAGE = `usage: autopilot-run [start] [--impl AGENT] [--reviewers A,B] [--max-rounds N] [--local]
       autopilot-run status
       autopilot-run stop

  AGENT        ${AGENTS.join(" | ")}。モデルは agy:gemini-3.8-flash-high のように付ける（既定: claude）
  --reviewers  レビュー担当（既定: 実装担当以外で PATH にあるもの全部）
  --max-rounds 修正ループの上限（1〜10、既定: 3）
  --local      push・PR・CI を行わず、ローカルの差分だけで回す（試運転用）`;

/** 起動を拒否する理由。使い方の誤りなので終了コード 2 で返す。 */
class UsageError extends Error {}

export interface StartOptions {
  impl: AgentSpec;
  reviewers: AgentSpec[];
  maxRounds: number;
  local: boolean;
}

/** 引数を読み、起動してよいかを確かめる。PATH の探索は findAgent に任せる。 */
export async function parseStartOptions(
  values: { impl: string; reviewers?: string; "max-rounds": string; local: boolean },
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

  const maxRounds = Number(values["max-rounds"]);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) {
    throw new UsageError(`--max-rounds は 1〜10 の整数: ${values["max-rounds"]}`);
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
      if (agent !== impl.agent && (await findAgent(agent))) reviewers.push({ agent });
    }
  }
  if (reviewers.length === 0) {
    throw new UsageError(
      `レビュー担当がいない。--reviewers で指定するか、${impl.agent} 以外のエージェント CLI を PATH に入れる`,
    );
  }
  return { impl, reviewers, maxRounds, local: values.local };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      impl: { type: "string", default: "claude" },
      reviewers: { type: "string" },
      "max-rounds": { type: "string", default: "3" },
      local: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
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

  // 既定ブランチへの直接 commit は、ブランチ保護の有無に関わらず起こさせない。
  const branch = await currentBranch(root);
  if (!branch) throw new UsageError("ブランチに乗っていない（detached HEAD）");
  const base = await defaultBranch(root, opts.local);
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
    const outcome = await start(state, root, base, opts);
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

async function start(state: State, root: string, base: string | null, opts: StartOptions) {
  const logPath = state.file("run.log");
  const baseSha = await resolveBaseSha(root, base);
  state.log(
    `start impl=${formatAgentSpec(opts.impl)} reviewers=${opts.reviewers.map(formatAgentSpec).join(",")} base=${baseSha.slice(0, 8)}${opts.local ? " (local)" : ""}`,
  );

  return runPipeline(
    { impl: opts.impl, reviewers: opts.reviewers, maxRounds: opts.maxRounds, baseSha },
    {
      async runAgent(spec: AgentSpec, prompt: string, outputName?: string) {
        state.log(`-> ${formatAgentSpec(spec)}`);
        const r = await run(buildArgv(spec, prompt), {
          cwd: root,
          logPath,
          stdoutPath: outputName ? state.file(outputName) : undefined,
        });
        return r.code === 0;
      },
      head: () => headSha(root),
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
