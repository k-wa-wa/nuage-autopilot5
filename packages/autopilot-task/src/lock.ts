import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 状態ディレクトリの解決（テスト時は $AUTOPILOT_STATE_DIR または $XDG_STATE_HOME で上書き可能）。 */
export function resolveStateDir(): string {
  const override = process.env.AUTOPILOT_STATE_DIR?.trim();
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg) return join(xdg, "autopilot5");
  const home = process.env.HOME?.trim() || homedir();
  return join(home, ".local", "state", "autopilot5");
}

export function taskLockPath(stateDir: string, name: string): string {
  return join(stateDir, "locks", `task-${name}.lock`);
}

export function memoryLockPath(stateDir: string, repoPath: string): string {
  const canonical = existsSync(repoPath) ? realpathSync(repoPath) : resolve(repoPath);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return join(stateDir, "locks", `memory-${hash}.lock`);
}

export interface LockHandle {
  release(): void;
}

export type TryLockResult =
  | { acquired: true; handle: LockHandle }
  | { acquired: false; pid: number | null };

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockFile(text: string): { pid: number | null; token: string | null } {
  const lines = text.trim().split("\n");
  const pid = Number(lines[0]);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    token: lines[1]?.trim() || null,
  };
}

/**
 * 排他ロックファイルを取得する。
 * 一時ファイルを作って hardlink で原子的に配置し、古いロック（死んだ PID）があれば掃除して取り直す。
 */
export function tryAcquireLock(lockPath: string): TryLockResult {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const payload = `${process.pid}\n${token}\n`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const tmpPath = `${lockPath}.${process.pid}.${token}.tmp`;
    writeFileSync(tmpPath, payload);
    try {
      linkSync(tmpPath, lockPath);
      rmSync(tmpPath, { force: true });
      return {
        acquired: true,
        handle: {
          release() {
            try {
              const current = readFileSync(lockPath, "utf8");
              if (parseLockFile(current).token === token) {
                rmSync(lockPath, { force: true });
              }
            } catch {}
          },
        },
      };
    } catch (e) {
      rmSync(tmpPath, { force: true });
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      let existingText: string;
      try {
        existingText = readFileSync(lockPath, "utf8");
      } catch {
        continue;
      }
      const existing = parseLockFile(existingText);
      if (existing.pid !== null && isPidAlive(existing.pid)) {
        return { acquired: false, pid: existing.pid };
      }
      // 死んだプロセスの古いロックだけを掃除する。別プロセスが直前に張り替えていたら消さない。
      try {
        if (readFileSync(lockPath, "utf8") === existingText) {
          unlinkSync(lockPath);
        }
      } catch {}
    }
  }

  return { acquired: false, pid: null };
}

/** 他プロセスが保持中のロックが空くまで待機して取得する（memory.repo 排他用）。 */
export async function acquireLockWithWait(
  lockPath: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const res = tryAcquireLock(lockPath);
    if (res.acquired) return res.handle;
    if (Date.now() >= deadline) {
      throw new Error(
        `ロックの取得がタイムアウトした (${lockPath}${res.pid ? `, holder pid=${res.pid}` : ""})`,
      );
    }
    await Bun.sleep(pollMs);
  }
}
