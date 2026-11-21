import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { AGENTS, type AgentName } from "../../autopilot-run/src/agents.ts";
import { DEFAULT_TASK_LEVEL, LEVELS, type Level } from "../../autopilot-run/src/models.ts";

export const DEFAULT_TIMEOUT_SEC = 3600;
export const DEFAULT_PRECHECK_TIMEOUT_SEC = 60;
export const DEFAULT_MEMORY_MAX_LINES = 200;

export type TaskTrigger = {
  type: "cron";
  schedule: string;
};

export interface TaskPrecheck {
  command: string;
  timeoutSec: number;
}

export interface TaskMemory {
  repo: string;
  file: string;
  maxLines: number;
}

export interface TaskConfig {
  name: string;
  soulFile: string;
  agent: AgentName | null;
  level: Level;
  trigger: TaskTrigger;
  precheck: TaskPrecheck | null;
  memory: TaskMemory | null;
  workdir: string | null;
  timeoutSec: number;
}

const ALLOWED_TOP_KEYS = new Set([
  "name",
  "soulFile",
  "agent",
  "level",
  "trigger",
  "precheck",
  "memory",
  "workdir",
  "timeoutSec",
]);

const ALLOWED_TRIGGER_KEYS = new Set(["type", "schedule"]);
const ALLOWED_PRECHECK_KEYS = new Set(["command", "timeoutSec"]);
const ALLOWED_MEMORY_KEYS = new Set(["repo", "file", "maxLines"]);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`${prefix}未知の項目: ${key}`);
    }
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} は空でない文字列で指定すること`);
  }
  return value;
}

function parsePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} は 0 より大きい数値で指定すること`);
  }
  return value;
}

function parsePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} は正の整数で指定すること`);
  }
  return value;
}

/** タスク設定 JSON を検証して正規化する。 */
export function parseTaskConfig(rawText: string, sourceLabel = "config"): TaskConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(
      `${sourceLabel}: JSON の解析に失敗した: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${sourceLabel}: 設定は JSON オブジェクトで書くこと`);
  }
  const prefix = `${sourceLabel}: `;
  rejectUnknownKeys(parsed, ALLOWED_TOP_KEYS, prefix);

  const name = requireNonEmptyString(parsed.name, `${prefix}name`);
  if (!NAME_RE.test(name) || name.includes("..") || name.length > 128) {
    throw new Error(
      `${prefix}name は英数字で始まり英数字・._- のみ（.. 不可、128 文字以内）で指定すること: ${name}`,
    );
  }

  const soulFile = requireNonEmptyString(parsed.soulFile, `${prefix}soulFile`);
  if (!isAbsolute(soulFile)) {
    throw new Error(`${prefix}soulFile は絶対パスで指定すること: ${soulFile}`);
  }
  if (!existsSync(soulFile) || !statSync(soulFile).isFile()) {
    throw new Error(`${prefix}soulFile が見つからない: ${soulFile}`);
  }

  let agent: AgentName | null = null;
  if (parsed.agent !== undefined && parsed.agent !== null) {
    if (typeof parsed.agent !== "string" || !AGENTS.includes(parsed.agent as AgentName)) {
      throw new Error(
        `${prefix}agent は ${AGENTS.join(" / ")} または null で指定すること: ${String(parsed.agent)}`,
      );
    }
    agent = parsed.agent as AgentName;
  }

  let level: Level = DEFAULT_TASK_LEVEL;
  if (parsed.level !== undefined) {
    if (typeof parsed.level !== "string" || !LEVELS.includes(parsed.level as Level)) {
      throw new Error(
        `${prefix}level は ${LEVELS.join(" / ")} のどれかで指定すること: ${String(parsed.level)}`,
      );
    }
    level = parsed.level as Level;
  }

  if (!isRecord(parsed.trigger)) {
    throw new Error(`${prefix}trigger はオブジェクトで指定すること`);
  }
  rejectUnknownKeys(parsed.trigger, ALLOWED_TRIGGER_KEYS, `${prefix}trigger.`);
  if (parsed.trigger.type !== "cron") {
    throw new Error(`${prefix}trigger.type は "cron" のみ対応している`);
  }
  const schedule = requireNonEmptyString(parsed.trigger.schedule, `${prefix}trigger.schedule`);
  const trigger: TaskTrigger = { type: "cron", schedule };

  let precheck: TaskPrecheck | null = null;
  if (parsed.precheck !== undefined && parsed.precheck !== null) {
    if (!isRecord(parsed.precheck)) {
      throw new Error(`${prefix}precheck はオブジェクトまたは null で指定すること`);
    }
    rejectUnknownKeys(parsed.precheck, ALLOWED_PRECHECK_KEYS, `${prefix}precheck.`);
    const command = requireNonEmptyString(parsed.precheck.command, `${prefix}precheck.command`);
    const timeoutSec =
      parsed.precheck.timeoutSec === undefined || parsed.precheck.timeoutSec === null
        ? DEFAULT_PRECHECK_TIMEOUT_SEC
        : parsePositiveNumber(parsed.precheck.timeoutSec, `${prefix}precheck.timeoutSec`);
    precheck = { command, timeoutSec };
  }

  let memory: TaskMemory | null = null;
  if (parsed.memory !== undefined && parsed.memory !== null) {
    if (!isRecord(parsed.memory)) {
      throw new Error(`${prefix}memory はオブジェクトまたは null で指定すること`);
    }
    rejectUnknownKeys(parsed.memory, ALLOWED_MEMORY_KEYS, `${prefix}memory.`);
    const repo = requireNonEmptyString(parsed.memory.repo, `${prefix}memory.repo`);
    if (!isAbsolute(repo)) {
      throw new Error(`${prefix}memory.repo は絶対パスで指定すること: ${repo}`);
    }
    const file = requireNonEmptyString(parsed.memory.file, `${prefix}memory.file`);
    if (isAbsolute(file)) {
      throw new Error(`${prefix}memory.file はリポジトリ内の相対パスで指定すること: ${file}`);
    }
    const rel = relative(resolve(repo), resolve(repo, file));
    if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`${prefix}memory.file がリポジトリ外を指している: ${file}`);
    }
    const maxLines =
      parsed.memory.maxLines === undefined || parsed.memory.maxLines === null
        ? DEFAULT_MEMORY_MAX_LINES
        : parsePositiveInt(parsed.memory.maxLines, `${prefix}memory.maxLines`);
    memory = { repo, file: rel, maxLines };
  }

  let workdir: string | null = null;
  if (parsed.workdir !== undefined && parsed.workdir !== null) {
    workdir = requireNonEmptyString(parsed.workdir, `${prefix}workdir`);
  }

  const timeoutSec =
    parsed.timeoutSec === undefined || parsed.timeoutSec === null
      ? DEFAULT_TIMEOUT_SEC
      : parsePositiveNumber(parsed.timeoutSec, `${prefix}timeoutSec`);

  return {
    name,
    soulFile,
    agent,
    level,
    trigger,
    precheck,
    memory,
    workdir,
    timeoutSec,
  };
}

export function loadTaskConfig(filePath: string): TaskConfig {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`設定ファイルが見つからない: ${filePath}`);
  }
  return parseTaskConfig(readFileSync(filePath, "utf8"), filePath);
}
