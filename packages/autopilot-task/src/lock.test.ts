import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireLockWithWait,
  memoryLockPath,
  resolveStateDir,
  taskLockPath,
  tryAcquireLock,
} from "./lock.ts";

let dir: string | null = null;
const savedEnv = {
  AUTOPILOT_STATE_DIR: process.env.AUTOPILOT_STATE_DIR,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  HOME: process.env.HOME,
};

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveStateDir", () => {
  test("AUTOPILOT_STATE_DIR → XDG_STATE_HOME → HOME/.local/state の順に解決する", () => {
    process.env.AUTOPILOT_STATE_DIR = "/tmp/override-state";
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";
    expect(resolveStateDir()).toBe("/tmp/override-state");

    delete process.env.AUTOPILOT_STATE_DIR;
    expect(resolveStateDir()).toBe("/tmp/xdg-state/autopilot5");

    delete process.env.XDG_STATE_HOME;
    process.env.HOME = "/tmp/user-home";
    expect(resolveStateDir()).toBe("/tmp/user-home/.local/state/autopilot5");
  });
});

describe("排他ロック", () => {
  test("取得中ロックは競合として拒否し、解放後に再取得できる", () => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-task-lock-"));
    const lock = taskLockPath(dir, "job");
    const first = tryAcquireLock(lock);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    const second = tryAcquireLock(lock);
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.pid).toBe(process.pid);

    first.handle.release();
    expect(existsSync(lock)).toBe(false);

    const third = tryAcquireLock(lock);
    expect(third.acquired).toBe(true);
    if (third.acquired) third.handle.release();
  });

  test("死んだ PID の古いロックを掃除して取得できる", () => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-task-lock-"));
    const lock = taskLockPath(dir, "stale");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "9999999\nold-token\n");

    const res = tryAcquireLock(lock);
    expect(res.acquired).toBe(true);
    if (res.acquired) res.handle.release();
  });

  test("生存中 PID でも boot_id や開始時刻が一致しない古いロックは回収できる", () => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-task-lock-"));
    const lock = taskLockPath(dir, "rebooted");
    mkdirSync(dirname(lock), { recursive: true });

    // 別ブートのロック（PID は現在の生きたプロセスと同じでも無効とみなす）
    writeFileSync(lock, `${process.pid}\nold-token\n00000000-0000-0000-0000-000000000000\n1\n`);
    const afterReboot = tryAcquireLock(lock);
    expect(afterReboot.acquired).toBe(true);
    if (afterReboot.acquired) afterReboot.handle.release();

    // 同一ブートで PID が再利用されたロック（開始時刻が異なる）
    const bootId = existsSync("/proc/sys/kernel/random/boot_id")
      ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      : "boot-id";
    writeFileSync(lock, `${process.pid}\nold-token\n${bootId}\n0\n`);
    const afterReuse = tryAcquireLock(lock);
    expect(afterReuse.acquired).toBe(true);
    if (afterReuse.acquired) afterReuse.handle.release();
  });

  test("acquireLockWithWait は保持者の解放を待って取得する", async () => {
    dir = mkdtempSync(join(tmpdir(), "autopilot-task-lock-"));
    const repoDir = join(dir, "repo");
    mkdirSync(repoDir);
    const lock = memoryLockPath(dir, repoDir);

    const holder = tryAcquireLock(lock);
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) return;

    setTimeout(() => holder.handle.release(), 80);
    const next = await acquireLockWithWait(lock, { timeoutMs: 2000, pollMs: 20 });
    next.release();
    expect(existsSync(lock)).toBe(false);
  });
});
