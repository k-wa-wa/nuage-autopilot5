import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentName } from "../../autopilot-run/src/agents.ts";

export interface ThreadSessionState {
  botName: string;
  channel: string;
  threadTs: string;
  participated: boolean;
  agent: AgentName | null;
  model?: string;
  effort?: string;
  sessionId: string | null;
  lastProcessedTs: string | null;
  createdAt: string;
  updatedAt: string;
}

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

function sanitizePart(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 32) || "x";
}

function threadFileName(channel: string, threadTs: string): string {
  const hash = createHash("sha256").update(threadKey(channel, threadTs)).digest("hex").slice(0, 12);
  return `${sanitizePart(channel)}_${sanitizePart(threadTs)}_${hash}.json`;
}

/** スレッド単位のセッション・参加状態を $AUTOPILOT_STATE_DIR 配下へ永続化する。 */
export class ThreadSessionStore {
  readonly dir: string;

  constructor(
    stateDir: string,
    readonly botName: string,
  ) {
    this.dir = join(stateDir, "slack-bot", botName, "threads");
  }

  private pathFor(channel: string, threadTs: string): string {
    return join(this.dir, threadFileName(channel, threadTs));
  }

  get(channel: string, threadTs: string): ThreadSessionState | null {
    const file = this.pathFor(channel, threadTs);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ThreadSessionState>;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        parsed.channel !== channel ||
        parsed.threadTs !== threadTs
      ) {
        return null;
      }
      return {
        botName: typeof parsed.botName === "string" ? parsed.botName : this.botName,
        channel,
        threadTs,
        participated: Boolean(parsed.participated),
        agent: parsed.agent ?? null,
        ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
        ...(typeof parsed.effort === "string" ? { effort: parsed.effort } : {}),
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
        lastProcessedTs: typeof parsed.lastProcessedTs === "string" ? parsed.lastProcessedTs : null,
        createdAt:
          typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  hasParticipated(channel: string, threadTs: string): boolean {
    return Boolean(this.get(channel, threadTs)?.participated);
  }

  save(state: ThreadSessionState): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.pathFor(state.channel, state.threadTs);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    try {
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}
