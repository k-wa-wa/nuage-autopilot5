import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AGENTS, type AgentName } from "../../autopilot-run/src/agents.ts";
import { DEFAULT_TASK_LEVEL, LEVELS, type Level } from "../../autopilot-run/src/models.ts";

export const DEFAULT_TIMEOUT_SEC = 3600;
export const DEFAULT_CONCURRENCY = 3;

export interface SlackBotConfig {
  name: string;
  soulFile: string;
  agent: AgentName | null;
  level: Level;
  apiBaseUrl: string | null;
  botTokenFile: string | null;
  appTokenFile: string | null;
  workdir: string | null;
  timeoutSec: number;
  concurrency: number;
}

export type TokenProvider = () => Promise<string>;

export type TokenSource = { kind: "file"; path: string } | { kind: "env"; value: string };

export interface SlackRuntimeEnv {
  apiBaseUrl: string;
  botTokenSource: TokenSource;
  appTokenSource: TokenSource;
  botToken: TokenProvider;
  appToken: TokenProvider;
}

const ALLOWED_TOP_KEYS = new Set([
  "name",
  "soulFile",
  "agent",
  "level",
  "apiBaseUrl",
  "botTokenFile",
  "appTokenFile",
  "workdir",
  "timeoutSec",
  "concurrency",
]);

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
  return value.trim();
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

/** HTTP / HTTPS の API ベース URL を検証し、末尾スラッシュを除いて正規化する。 */
export function normalizeApiBaseUrl(raw: string, field = "apiBaseUrl"): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${field} は空でない URL で指定すること`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${field} が正しい URL ではない: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} は http または https の URL で指定すること: ${raw}`);
  }
  return trimmed.replace(/\/+$/, "");
}

/** Slack Bot 設定 JSON を検証して正規化する。 */
export function parseSlackBotConfig(rawText: string, sourceLabel = "config"): SlackBotConfig {
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

  let apiBaseUrl: string | null = null;
  if (parsed.apiBaseUrl !== undefined && parsed.apiBaseUrl !== null) {
    const rawUrl = requireNonEmptyString(parsed.apiBaseUrl, `${prefix}apiBaseUrl`);
    apiBaseUrl = normalizeApiBaseUrl(rawUrl, `${prefix}apiBaseUrl`);
  }

  let botTokenFile: string | null = null;
  if (parsed.botTokenFile !== undefined && parsed.botTokenFile !== null) {
    botTokenFile = requireNonEmptyString(parsed.botTokenFile, `${prefix}botTokenFile`);
    if (!isAbsolute(botTokenFile)) {
      throw new Error(`${prefix}botTokenFile は絶対パスで指定すること: ${botTokenFile}`);
    }
  }

  let appTokenFile: string | null = null;
  if (parsed.appTokenFile !== undefined && parsed.appTokenFile !== null) {
    appTokenFile = requireNonEmptyString(parsed.appTokenFile, `${prefix}appTokenFile`);
    if (!isAbsolute(appTokenFile)) {
      throw new Error(`${prefix}appTokenFile は絶対パスで指定すること: ${appTokenFile}`);
    }
  }

  let workdir: string | null = null;
  if (parsed.workdir !== undefined && parsed.workdir !== null) {
    workdir = requireNonEmptyString(parsed.workdir, `${prefix}workdir`);
  }

  const timeoutSec =
    parsed.timeoutSec === undefined || parsed.timeoutSec === null
      ? DEFAULT_TIMEOUT_SEC
      : parsePositiveNumber(parsed.timeoutSec, `${prefix}timeoutSec`);

  const concurrency =
    parsed.concurrency === undefined || parsed.concurrency === null
      ? DEFAULT_CONCURRENCY
      : parsePositiveInt(parsed.concurrency, `${prefix}concurrency`);

  return {
    name,
    soulFile,
    agent,
    level,
    apiBaseUrl,
    botTokenFile,
    appTokenFile,
    workdir,
    timeoutSec,
    concurrency,
  };
}

export function loadSlackBotConfig(filePath: string): SlackBotConfig {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`設定ファイルが見つからない: ${filePath}`);
  }
  return parseSlackBotConfig(readFileSync(filePath, "utf8"), filePath);
}

export interface FileTokenProviderOptions {
  label: string;
  filePath: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

const NON_RETRYABLE_FS_CODES = new Set(["EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP"]);

/** 静的トークン文字列を返す TokenProvider を生成する。 */
export function createStaticTokenProvider(token: string): TokenProvider {
  const trimmed = token.trim();
  return async () => {
    if (!trimmed) {
      throw new Error("トークンが空である");
    }
    return trimmed;
  };
}

/**
 * トークンファイルを都度読み込み、前後の空白・改行を除いて返す TokenProvider を生成する。
 * spiffe-helper 等による書き換え瞬間の一時的な空ファイル・欠損に備えて短時間リトライする。
 */
export function createFileTokenProvider(opts: FileTokenProviderOptions): TokenProvider {
  const maxRetries = opts.maxRetries ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 30;
  return async () => {
    let lastReason = "ファイルが空である";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const raw = await readFile(opts.filePath, "utf8");
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
        lastReason = "ファイルが空である";
      } catch (e) {
        const code =
          typeof e === "object" && e !== null && "code" in e
            ? String((e as { code?: unknown }).code)
            : "";
        const msg = e instanceof Error ? e.message : String(e);
        if (NON_RETRYABLE_FS_CODES.has(code)) {
          throw new Error(`${opts.label} (${opts.filePath}) を読み込めない: ${msg}`);
        }
        lastReason = msg;
      }
      if (attempt < maxRetries && retryDelayMs > 0) {
        await Bun.sleep(retryDelayMs);
      }
    }
    throw new Error(`${opts.label} (${opts.filePath}) を読み込めない: ${lastReason}`);
  };
}

function resolveTokenChannel(opts: {
  fileEnvName: string;
  tokenEnvName: string;
  configFieldName: string;
  configFile: string | null | undefined;
  env: NodeJS.ProcessEnv;
}): { source: TokenSource; provider: TokenProvider } {
  const filePath = opts.env[opts.fileEnvName]?.trim() || opts.configFile?.trim() || "";
  if (filePath) {
    return {
      source: { kind: "file", path: filePath },
      provider: createFileTokenProvider({ label: opts.fileEnvName, filePath }),
    };
  }
  const token = opts.env[opts.tokenEnvName]?.trim() || "";
  if (!token) {
    throw new Error(
      `${opts.fileEnvName}（または設定 JSON の ${opts.configFieldName}）あるいは ${opts.tokenEnvName} を指定すること`,
    );
  }
  return {
    source: { kind: "env", value: token },
    provider: createStaticTokenProvider(token),
  };
}

/** 実行時の環境変数と設定値を結合して解決する（環境変数を常に優先し、*_FILE 未設定時のみ静的トークンを使う）。 */
export function resolveSlackRuntimeEnv(
  config: Pick<SlackBotConfig, "apiBaseUrl" | "botTokenFile" | "appTokenFile">,
  env: NodeJS.ProcessEnv = process.env,
): SlackRuntimeEnv {
  const rawBaseUrl = env.SLACK_API_BASE_URL?.trim() || config.apiBaseUrl?.trim() || "";
  if (!rawBaseUrl) {
    throw new Error("SLACK_API_BASE_URL（または設定 JSON の apiBaseUrl）を指定すること");
  }
  const apiBaseUrl = normalizeApiBaseUrl(rawBaseUrl, "SLACK_API_BASE_URL");

  const bot = resolveTokenChannel({
    fileEnvName: "SLACK_BOT_TOKEN_FILE",
    tokenEnvName: "SLACK_BOT_TOKEN",
    configFieldName: "botTokenFile",
    configFile: config.botTokenFile,
    env,
  });

  const app = resolveTokenChannel({
    fileEnvName: "SLACK_APP_TOKEN_FILE",
    tokenEnvName: "SLACK_APP_TOKEN",
    configFieldName: "appTokenFile",
    configFile: config.appTokenFile,
    env,
  });

  return {
    apiBaseUrl,
    botTokenSource: bot.source,
    appTokenSource: app.source,
    botToken: bot.provider,
    appToken: app.provider,
  };
}
