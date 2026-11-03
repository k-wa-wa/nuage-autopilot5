import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capture, cleanEnv, killAll, run } from "./exec.ts";
import { tempDir } from "./testing/helpers.ts";

const BUN = process.execPath;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("cleanEnv", () => {
  test("Orca の状態フック用の変数を子に渡さない", () => {
    const env = cleanEnv({ PATH: "/bin", ORCA_AGENT_HOOK_PORT: "1", ORCA_PANE_KEY: "x" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("run", () => {
  let dir: ReturnType<typeof tempDir>;
  afterEach(() => dir.cleanup());

  test("標準出力は stdoutPath に、標準エラーは log に書く", async () => {
    dir = tempDir();
    const out = join(dir.path, "out.md");
    const log = join(dir.path, "run.log");
    const r = await run([BUN, "-e", "console.log('指摘なし'); console.error('warn')"], {
      cwd: dir.path,
      stdoutPath: out,
      logPath: log,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("指摘なし\n");
    expect(readFileSync(log, "utf8")).toBe("warn\n");
  });

  test("stdoutPath を渡さなければ標準出力も log に書く", async () => {
    dir = tempDir();
    const log = join(dir.path, "run.log");
    await run([BUN, "-e", "console.log('hello')"], { cwd: dir.path, logPath: log });
    expect(readFileSync(log, "utf8")).toBe("hello\n");
  });

  test("終了コードを返し、コマンドが無ければ 127 にして log に残す", async () => {
    dir = tempDir();
    const log = join(dir.path, "run.log");
    expect((await run([BUN, "-e", "process.exit(3)"], { cwd: dir.path, logPath: log })).code).toBe(
      3,
    );
    expect((await run(["no-such-command-xyz"], { cwd: dir.path, logPath: log })).code).toBe(127);
    expect(readFileSync(log, "utf8")).toContain("no-such-command-xyz");
  });

  test("子には ORCA_* を渡さない", async () => {
    dir = tempDir();
    const out = join(dir.path, "env.txt");
    process.env.ORCA_PANE_KEY = "pane";
    try {
      await run(
        [
          BUN,
          "-e",
          "console.log(Object.keys(process.env).filter(k => k.startsWith('ORCA_')).join())",
        ],
        { cwd: dir.path, stdoutPath: out, logPath: join(dir.path, "run.log") },
      );
    } finally {
      delete process.env.ORCA_PANE_KEY;
    }
    expect(readFileSync(out, "utf8").trim()).toBe("");
  });

  test("killAll は子だけでなく孫（エージェントが起動したビルド等）も止める", async () => {
    dir = tempDir();
    const pidFile = join(dir.path, "grandchild.pid");
    const script = `
      const c = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 600000)"]);
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setTimeout(() => {}, 600000);
    `;
    const p = run([BUN, "-e", script], { cwd: dir.path, logPath: join(dir.path, "run.log") });
    let grandchild = 0;
    for (let i = 0; i < 100 && !grandchild; i++) {
      await Bun.sleep(50);
      try {
        grandchild = Number(readFileSync(pidFile, "utf8"));
      } catch {}
    }
    expect(alive(grandchild)).toBe(true);
    killAll();
    await p;
    for (let i = 0; i < 40 && alive(grandchild); i++) await Bun.sleep(50);
    expect(alive(grandchild)).toBe(false);
  });
});

describe("capture", () => {
  test("出力の前後の空白を落として返す", async () => {
    const r = await capture([BUN, "-e", "console.log('  x  '); console.error('e')"], process.cwd());
    expect(r).toEqual({ code: 0, stdout: "x", stderr: "e" });
  });
});
