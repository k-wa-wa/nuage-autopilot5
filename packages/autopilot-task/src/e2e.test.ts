import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskLockPath, tryAcquireLock } from "./lock.ts";

const MAIN = join(import.meta.dir, "main.ts");
const HOOK = join(import.meta.dir, "../../safe-gh/src/hook.ts");
const TIMEOUT = 30_000;

let dir: string | null = null;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

interface CallRecord {
  agent: string;
  args: string[];
  prompt: string;
  cwd: string;
  envOrca: string[];
}

function setupWorld() {
  const root = mkdtempSync(join(tmpdir(), "autopilot-task-e2e-"));
  dir = root;
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  const callsDir = join(root, "calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(callsDir, { recursive: true });

  const soul = join(root, "SOUL.md");
  writeFileSync(soul, "# Test Soul\nタスクを実行すること。\n");

  const installFakeAgent = (name: "claude" | "agy" | "codex", scriptPath: string) => {
    const wrapper = join(bin, name);
    writeFileSync(
      wrapper,
      `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const envOrca = Object.keys(process.env).filter((k) => k.startsWith("ORCA_"));
appendFileSync(${JSON.stringify(join(callsDir, "calls.jsonl"))}, JSON.stringify({ agent: ${JSON.stringify(name)}, args, prompt, cwd: process.cwd(), envOrca }) + "\\n");
const cfg = JSON.parse(readFileSync(${JSON.stringify(scriptPath)}, "utf8"));
const step = cfg[${JSON.stringify(name)}] ?? { code: 0, stdout: "ok" };
if (step.sleepMs) await Bun.sleep(step.sleepMs);
if (step.writeMemoryPath && step.writeMemoryContent !== undefined) {
  writeFileSync(step.writeMemoryPath, step.writeMemoryContent);
}
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.code ?? 0);
`,
    );
    chmodSync(wrapper, 0o755);
  };

  const scriptPath = join(root, "agent-script.json");
  writeFileSync(scriptPath, JSON.stringify({}));
  installFakeAgent("claude", scriptPath);
  installFakeAgent("agy", scriptPath);
  installFakeAgent("codex", scriptPath);

  const readCalls = (): CallRecord[] => {
    const p = join(callsDir, "calls.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CallRecord);
  };

  const runCli = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, MAIN, ...args], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        AUTOPILOT_STATE_DIR: stateDir,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  };

  return { root, bin, stateDir, soul, scriptPath, readCalls, runCli };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("autopilot-task E2E", () => {
  test("check-config は妥当な設定で 0、不正な設定で 2 を返す", async () => {
    const w = setupWorld();
    const okCfg = join(w.root, "ok.json");
    writeFileSync(
      okCfg,
      JSON.stringify({
        name: "valid-task",
        soulFile: w.soul,
        trigger: { type: "cron", schedule: "daily" },
      }),
    );
    const badCfg = join(w.root, "bad.json");
    writeFileSync(
      badCfg,
      JSON.stringify({
        name: "bad-task",
        soulFile: join(w.root, "missing.md"),
        trigger: { type: "cron", schedule: "daily" },
      }),
    );

    const r1 = await w.runCli(["check-config", "--file", okCfg]);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain("valid-task: ok");

    const r2 = await w.runCli(["check-config", "--file", badCfg]);
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain("soulFile");
  });

  test("排他ロック競合時はエージェントを起動せずスキップして exit 0 で終わる", async () => {
    const w = setupWorld();
    const cfg = join(w.root, "cfg.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        name: "locked-task",
        soulFile: w.soul,
        trigger: { type: "cron", schedule: "daily" },
      }),
    );
    const lock = tryAcquireLock(taskLockPath(w.stateDir, "locked-task"));
    expect(lock.acquired).toBe(true);
    try {
      const r = await w.runCli(["run", "--config", cfg]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("すでに実行中");
      expect(w.readCalls()).toHaveLength(0);
    } finally {
      if (lock.acquired) lock.handle.release();
    }
  });

  test("precheck 失敗・タイムアウト時はエージェントを起動せずスキップして exit 0 で終わる", async () => {
    const w = setupWorld();
    const cfgFail = join(w.root, "precheck-fail.json");
    writeFileSync(
      cfgFail,
      JSON.stringify({
        name: "pre-fail",
        soulFile: w.soul,
        trigger: { type: "cron", schedule: "daily" },
        precheck: { command: "exit 1" },
      }),
    );
    const r1 = await w.runCli(["run", "--config", cfgFail]);
    expect(r1.code).toBe(0);
    expect(r1.stdout).toContain("precheck");
    expect(w.readCalls()).toHaveLength(0);

    const cfgTimeout = join(w.root, "precheck-timeout.json");
    writeFileSync(
      cfgTimeout,
      JSON.stringify({
        name: "pre-timeout",
        soulFile: w.soul,
        trigger: { type: "cron", schedule: "daily" },
        precheck: { command: "sleep 5", timeoutSec: 0.1 },
      }),
    );
    const r2 = await w.runCli(["run", "--config", cfgTimeout]);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("タイムアウト");
    expect(w.readCalls()).toHaveLength(0);
  });

  test("ORCA_* を除去し、unavailable 時は models.yaml の次候補へフォールバックする", async () => {
    const w = setupWorld();
    const modelsFile = join(w.root, "models.yaml");
    writeFileSync(modelsFile, "roles:\n  impl: [agy, codex]\n");
    writeFileSync(
      w.scriptPath,
      JSON.stringify({
        agy: { code: 1, stderr: "You've hit your session limit" },
        codex: {
          code: 0,
          stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`,
        },
      }),
    );

    const eventFile = join(w.root, "event.json");
    writeFileSync(eventFile, '{"event":"ping"}');
    const cfg = join(w.root, "fallback.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        name: "fallback-task",
        soulFile: w.soul,
        trigger: { type: "cron", schedule: "daily" },
        precheck: { command: 'test -z "$ORCA_PANE_KEY"' },
      }),
    );

    const r = await w.runCli(["run", "--config", cfg, "--event-file", eventFile], {
      AUTOPILOT_MODELS: modelsFile,
      ORCA_PANE_KEY: "secret-pane",
    });
    expect(r.code).toBe(0);
    const calls = w.readCalls();
    expect(calls.map((c) => c.agent)).toEqual(["agy", "codex"]);
    expect(calls[0]!.envOrca).toEqual([]);
    expect(calls[1]!.envOrca).toEqual([]);
    expect(calls[1]!.prompt).toContain('{"event":"ping"}');
    // workdir 未指定時はタスク専用ディレクトリが使われる
    expect(calls[1]!.cwd).toBe(join(w.stateDir, "workdirs", "fallback-task"));
  });

  test(
    "記憶リポの読み込み・更新・commit・push と pre-commit 機密検査が動く",
    async () => {
      const w = setupWorld();
      const origin = join(w.root, "origin.git");
      const memRepo = join(w.root, "memory");
      execFileSync("git", ["init", "--bare", "-b", "main", origin]);
      execFileSync("git", ["clone", origin, memRepo]);
      git(memRepo, "config", "user.name", "bot");
      git(memRepo, "config", "user.email", "bot@example.com");
      writeFileSync(join(memRepo, "README.md"), "# mem\n");
      git(memRepo, "add", "README.md");
      git(memRepo, "commit", "-m", "init");
      git(memRepo, "push", "-u", "origin", "main");

      // safe-gh の pre-commit フックを core.hooksPath 経由で仕込む
      const hooksDir = join(w.root, "hooks");
      mkdirSync(hooksDir);
      const hookWrapper = join(hooksDir, "pre-commit");
      writeFileSync(hookWrapper, `#!/bin/sh\nexec ${process.execPath} ${HOOK} "$@"\n`);
      chmodSync(hookWrapper, 0o755);
      git(memRepo, "config", "core.hooksPath", hooksDir);

      const memTarget = join(memRepo, "tasks", "mem-task.md");
      writeFileSync(
        w.scriptPath,
        JSON.stringify({
          claude: {
            code: 0,
            stdout: "updated",
            writeMemoryPath: memTarget,
            writeMemoryContent: "2026-11-22: 正常に記録\n",
          },
        }),
      );

      const cfg = join(w.root, "mem.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          name: "mem-task",
          soulFile: w.soul,
          agent: "claude",
          trigger: { type: "cron", schedule: "daily" },
          memory: { repo: memRepo, file: "tasks/mem-task.md", maxLines: 50 },
        }),
      );

      const r = await w.runCli(["run", "--config", cfg]);
      expect(r.code).toBe(0);
      expect(git(origin, "log", "-1", "--pretty=%s")).toBe("chore(memory): update mem-task");
      expect(readFileSync(memTarget, "utf8")).toBe("2026-11-22: 正常に記録\n");

      // 機密情報を含む記憶は pre-commit フックで弾かれること
      const fakePat = ["ghp", "xK9pL2mQ8vR4tY7wZ1bN5cF3hJ6sD0gA9eC4"].join("_");
      writeFileSync(
        w.scriptPath,
        JSON.stringify({
          claude: {
            code: 0,
            stdout: "leaked",
            writeMemoryPath: memTarget,
            writeMemoryContent: `token=${fakePat}\n`,
          },
        }),
      );
      const rSecret = await w.runCli(["run", "--config", cfg]);
      expect(rSecret.code).toBe(1);
      expect(git(origin, "log", "-1", "--pretty=%s")).toBe("chore(memory): update mem-task");
      // 秘密情報で拒否された内容が作業ツリーに残っていないこと
      expect(readFileSync(memTarget, "utf8")).toBe("2026-11-22: 正常に記録\n");
    },
    TIMEOUT,
  );

  test(
    "記憶同期で rebase が衝突したら git rebase --abort で復帰し commit/push しない",
    async () => {
      const w = setupWorld();
      const origin = join(w.root, "origin.git");
      const memRepo = join(w.root, "memory");
      execFileSync("git", ["init", "--bare", "-b", "main", origin]);
      execFileSync("git", ["clone", origin, memRepo]);
      git(memRepo, "config", "user.name", "bot");
      git(memRepo, "config", "user.email", "bot@example.com");
      writeFileSync(join(memRepo, "memo.md"), "v1\n");
      git(memRepo, "add", "memo.md");
      git(memRepo, "commit", "-m", "v1");
      git(memRepo, "push", "-u", "origin", "main");

      // ローカルに未 push のコミットを残した状態で、実行中に別クローンから衝突コミットを push する
      writeFileSync(join(memRepo, "memo.md"), "local-unpushed\n");
      git(memRepo, "add", "memo.md");
      git(memRepo, "commit", "-m", "local unpushed");

      const other = join(w.root, "other");
      execFileSync("git", ["clone", origin, other]);
      git(other, "config", "user.name", "other");
      git(other, "config", "user.email", "other@example.com");

      const memTarget = join(memRepo, "memo.md");
      const cfg = join(w.root, "rebase-fail.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          name: "rebase-fail",
          soulFile: w.soul,
          agent: "claude",
          trigger: { type: "cron", schedule: "daily" },
          memory: { repo: memRepo, file: "memo.md" },
        }),
      );

      const claudeBin = join(w.bin, "claude");
      writeFileSync(
        claudeBin,
        `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(other, "memo.md"))}, "remote-conflict\\n");
execFileSync("git", ["add", "memo.md"], { cwd: ${JSON.stringify(other)} });
execFileSync("git", ["commit", "-m", "remote conflict"], { cwd: ${JSON.stringify(other)} });
execFileSync("git", ["push"], { cwd: ${JSON.stringify(other)} });
writeFileSync(${JSON.stringify(memTarget)}, "agent-local-conflict\\n");
`,
      );
      chmodSync(claudeBin, 0o755);

      const r = await w.runCli(["run", "--config", cfg]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("git pull --rebase --autostash に失敗");
      expect(existsSync(join(memRepo, ".git", "rebase-merge"))).toBe(false);
      expect(existsSync(join(memRepo, ".git", "rebase-apply"))).toBe(false);
      expect(git(origin, "log", "-1", "--pretty=%s")).toBe("remote conflict");
      // rebase --abort 後にエージェントの書き込みと未 push コミットが失われていないこと
      expect(readFileSync(memTarget, "utf8")).toBe("agent-local-conflict\n");
      expect(git(memRepo, "log", "-1", "--pretty=%s")).toBe("local unpushed");
    },
    TIMEOUT,
  );

  test(
    "unavailable の前に記憶ファイルや作業ツリーを変更していたら別候補へ切り替えず記憶を元に戻す",
    async () => {
      const w = setupWorld();
      const memRepo = join(w.root, "memory");
      mkdirSync(memRepo);
      git(memRepo, "init", "-b", "main");
      git(memRepo, "config", "user.name", "bot");
      git(memRepo, "config", "user.email", "bot@example.com");
      writeFileSync(join(memRepo, "README.md"), "# mem\n");
      git(memRepo, "add", "README.md");
      git(memRepo, "commit", "-m", "init");

      const modelsFile = join(w.root, "models.yaml");
      writeFileSync(modelsFile, "roles:\n  impl: [agy, codex]\n");
      const memTarget = join(memRepo, "tasks", "partial.md");
      writeFileSync(
        w.scriptPath,
        JSON.stringify({
          agy: {
            code: 1,
            stderr: "You've hit your session limit",
            writeMemoryPath: memTarget,
            writeMemoryContent: "partial write before limit\n",
          },
          codex: { code: 0, stdout: "should not run" },
        }),
      );

      const cfg = join(w.root, "partial-unavail.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          name: "partial-unavail",
          soulFile: w.soul,
          trigger: { type: "cron", schedule: "daily" },
          memory: { repo: memRepo, file: "tasks/partial.md" },
        }),
      );

      const r = await w.runCli(["run", "--config", cfg], { AUTOPILOT_MODELS: modelsFile });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("別候補へ切り替えない");
      expect(w.readCalls().map((c) => c.agent)).toEqual(["agy"]);
      // 失敗した実行で新規作成した記憶ファイルはロールバックされて残らないこと
      expect(existsSync(memTarget)).toBe(false);
    },
    TIMEOUT,
  );

  test("timeoutSec を超えたらプロセスグループごと停止して exit 1 で終わる", async () => {
    const w = setupWorld();
    writeFileSync(
      w.scriptPath,
      JSON.stringify({
        claude: { code: 0, sleepMs: 5000 },
      }),
    );
    const cfg = join(w.root, "timeout.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        name: "timeout-task",
        soulFile: w.soul,
        agent: "claude",
        trigger: { type: "cron", schedule: "daily" },
        timeoutSec: 0.2,
      }),
    );

    const r = await w.runCli(["run", "--config", cfg]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("タイムアウト");
  });
});
