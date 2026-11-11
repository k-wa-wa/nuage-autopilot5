/**
 * エージェント CLI ごとの違いはここだけに閉じる。
 * 他のモジュールは「どのエージェントに、どのモデルで、どのプロンプトを渡すか」しか知らない。
 */

export const AGENTS = ["claude", "agy", "codex"] as const;
export type AgentName = (typeof AGENTS)[number];

/** 1 回の実行で使うモデルと effort。省略したものは CLI の既定になる。 */
export interface ModelChoice {
  model?: string;
  effort?: string;
}

/** エージェントを 1 回実行する単位。 */
export interface Invocation extends ModelChoice {
  agent: AgentName;
}

/**
 * 担当の指定。models は前から順に試す並びで、空なら models.yaml の並びを使う。
 * 書き方: `agy`、`agy:MODEL`、`claude:MODEL@EFFORT/MODEL`
 */
export interface AgentSpec {
  agent: AgentName;
  models: ModelChoice[];
}

/** `MODEL`、`MODEL@EFFORT`、`@EFFORT` を読む。 */
export function parseModelChoice(text: string): ModelChoice {
  const t = text.trim();
  const at = t.lastIndexOf("@");
  const model = at === -1 ? t : t.slice(0, at);
  const effort = at === -1 ? "" : t.slice(at + 1);
  if (!model && !effort) throw new Error(`モデルが空: "${text}"`);
  if (at !== -1 && !effort) throw new Error(`@ の後に effort が無い: "${text}"`);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function formatModelChoice(m: ModelChoice): string {
  return `${m.model ?? ""}${m.effort ? `@${m.effort}` : ""}`;
}

export function parseAgentSpec(text: string): AgentSpec {
  const t = text.trim();
  const colon = t.indexOf(":");
  const agent = colon === -1 ? t : t.slice(0, colon);
  if (!AGENTS.includes(agent as AgentName)) {
    throw new Error(`unknown agent: ${agent}（${AGENTS.join(" / ")}）`);
  }
  const rest = colon === -1 ? "" : t.slice(colon + 1);
  const models = rest ? rest.split("/").map(parseModelChoice) : [];
  return { agent: agent as AgentName, models };
}

export function formatAgentSpec(spec: AgentSpec): string {
  return spec.models.length > 0
    ? `${spec.agent}:${spec.models.map(formatModelChoice).join("/")}`
    : spec.agent;
}

export function formatInvocation(inv: Invocation): string {
  const m = formatModelChoice(inv);
  return m ? `${inv.agent}:${m}` : inv.agent;
}

/**
 * 会話の引き継ぎ。修正担当が実装担当の会話の続きで動けば、コードを一から読み直さずに済む。
 *
 * - start: 新しい会話を始める。claude には id を渡す。agy と codex は出力から読む
 * - resume: id の会話の続きで実行する
 */
export type SessionRequest = { kind: "start"; id: string } | { kind: "resume"; id: string };

function sessionArgs(agent: AgentName, s: SessionRequest | undefined): string[] {
  if (!s) return [];
  switch (agent) {
    case "claude":
      return s.kind === "start" ? ["--session-id", s.id] : ["--resume", s.id];
    case "agy":
      // 会話 ID は JSON の出力にしか出ない。
      return [...(s.kind === "resume" ? ["--conversation", s.id] : []), "--output-format", "json"];
    case "codex":
      return s.kind === "resume" ? [s.id] : [];
  }
}

/** 会話を引き継いだ実行の標準出力から、会話 ID と本文を読む。ID が読めなければ session は null。 */
export function readSessionOutput(
  agent: AgentName,
  s: SessionRequest | undefined,
  stdout: string,
): { session: string | null; text: string } {
  if (agent === "codex") {
    const events = jsonEvents(stdout);
    const thread = events.find((e) => e.type === "thread.started");
    const messages = events.flatMap((e) => {
      const item = e.item;
      return e.type === "item.completed" &&
        isRecord(item) &&
        item.type === "agent_message" &&
        typeof item.text === "string"
        ? [item.text]
        : [];
    });
    return {
      session:
        typeof thread?.thread_id === "string"
          ? thread.thread_id
          : s?.kind === "resume"
            ? s.id
            : null,
      text: messages.at(-1) ?? "",
    };
  }
  if (agent !== "agy" || !s) return { session: s?.id ?? null, text: stdout };
  try {
    const out: unknown = JSON.parse(stdout);
    const field = (k: string) => (isRecord(out) && typeof out[k] === "string" ? out[k] : null);
    return { session: field("conversation_id") || null, text: field("response") ?? stdout };
  } catch {
    return { session: null, text: stdout };
  }
}

export type FailureKind = "unavailable" | "error";

/** CLI 自体の利用不能だけを切り替え対象にする。通常の失敗や通信障害は対象外。 */
export function classifyFailure(
  agent: AgentName,
  result: { code: number; stdout: string; stderr: string },
): FailureKind | null {
  const errors =
    agent === "codex"
      ? jsonEvents(result.stdout).filter((e) => e.type === "turn.failed" || e.type === "error")
      : [];
  if (result.code === 0 && !errors.some((e) => e.type === "turn.failed")) return null;
  // 終了シグナル・CLI 未導入は、出力の内容にかかわらず停止する。
  if (result.code === 127 || result.code >= 128) return "error";
  // 通常の応答本文中に書かれたエラー例を、CLI の診断と取り違えない。
  const events = agent === "agy" ? jsonEvents(result.stdout) : [];
  const structured = agent === "codex" ? errors : events;
  const trusted = [result.stderr, ...structured.map((e) => errorMessage(e))].join("\n");
  const stdout = agent === "codex" || events.length > 0 ? "" : result.stdout;
  // 機械的なコードはログの接頭辞があっても拾う。通常の stdout 本文には適用しない。
  if (
    /\b(?:rate_limit_exceeded|usage_limit_reached|insufficient_quota|resource_?exhausted|context_length_exceeded|context_window_exceeded)\b/i.test(
      trusted,
    )
  )
    return "unavailable";
  const diagnostics = `${trusted}\n${stdout}`
    .split("\n")
    .map((line) => line.trim().replace(/^(?:(?:Error|API Error):\s*)+/i, ""));
  const unavailable = [
    /^(?:rate_limit_exceeded|usage_limit_reached|insufficient_quota|resource_exhausted|context_length_exceeded|context_window_exceeded)\b/i,
    /^(?:you(?:['’]ve| have)?\s+)?(?:hit|reached|exceeded) (?:your |the )?(?:(?:usage|session|weekly|monthly|daily|5-hour|spend|rate|token|request|credit) ){1,3}(?:limit|budget|cap)\b/i,
    /^(?:claude(?: ai)? )?(?:quota|(?:usage|rate|token|request|session|weekly|5-hour|context|spend)(?: usage)? limit) (?:exceeded|exhausted|reached)\b/i,
    /^[A-Z][\w-]* limit reached\b.*resets\b/,
    /^(?:too many requests|your credit balance is too low|your workspace is out of credits)\b/i,
    /^(?:your )?(?:oauth|access|auth(?:entication)?) (?:token )?(?:has )?(?:expired|invalid)\b/i,
    /^(?:your )?(?:access|refresh) token could not be refreshed\b/i,
    /^(?:your )?(?:token|session|conversation) (?:has )?expired\b/i,
    /^(?:session|conversation)(?: [\w-]+)? (?:not found|does not exist)\b|^no (?:session|conversation|rollout) found\b/i,
    /^(?:context window|context length|maximum context length).*(?:exceed|limit|full)|^codex ran out of room in the model['’]s context window\b|^prompt is too long\b/i,
    /^invalid api key\b|^please (?:run .*login|log in|login|(?:log out and )?sign in)|^not (?:logged|signed) in\b/i,
  ];
  // HTTP ステータス単独では、通常の本文「429 を返す」などと区別できない。
  if (
    /^(?:API Error:\s*)?(?:401|429)\b/im.test(trusted) ||
    /\b(?:last status:\s*429|429 Too Many Requests)\b/i.test(trusted) ||
    /^(?:Error:\s*)?API Error:\s*(?:401|429)\b/im.test(stdout)
  )
    return "unavailable";
  return diagnostics.some((line) => unavailable.some((pattern) => pattern.test(line)))
    ? "unavailable"
    : "error";
}

/** 構造化出力のエラーだけを読む。response / item の本文は診断に使わない。 */
function errorMessage(event: Record<string, unknown>): string {
  if (typeof event.error === "string") return event.error;
  const error = isRecord(event.error) ? event.error : event;
  return typeof error.message === "string" ? error.message : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEvents(stdout: string): Record<string, unknown>[] {
  return stdout.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

/**
 * 非対話で 1 ターン実行するコマンド。
 * 人間は不在なので、どのエージェントも権限確認を飛ばす。
 */
export function buildArgv(inv: Invocation, prompt: string, session?: SessionRequest): string[] {
  const model = inv.model ? ["--model", inv.model] : [];
  const conversation = sessionArgs(inv.agent, session);
  const effort = (flag: string) => (inv.effort ? [flag, inv.effort] : []);
  switch (inv.agent) {
    case "claude":
      return [
        "claude",
        ...model,
        ...conversation,
        ...effort("--effort"),
        "--dangerously-skip-permissions",
        "-p",
        prompt,
      ];
    case "agy":
      // agy の -p は直後の引数をプロンプトとして読むので、必ず末尾に置く。
      return [
        "agy",
        ...model,
        ...conversation,
        ...effort("--effort"),
        "--dangerously-skip-permissions",
        "-p",
        prompt,
      ];
    case "codex":
      return [
        "codex",
        "exec",
        ...(session?.kind === "resume" ? ["resume"] : []),
        ...model,
        ...(inv.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(inv.effort)}`] : []),
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        ...conversation,
        // オプションに見えるプロンプトも位置引数として渡す。
        "--",
        prompt,
      ];
  }
}
