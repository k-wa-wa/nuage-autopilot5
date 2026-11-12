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

export type FailureKind = "unavailable" | "error";

export interface AgentProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgentResult {
  session: string | null;
  text: string;
  failure: FailureKind | null;
}

/** CLI ごとのコマンドと出力形式を、共通の呼び出し方に変換する。 */
export interface AgentAdapter {
  buildArgv(choice: ModelChoice, prompt: string, session?: SessionRequest): string[];
  readResult(result: AgentProcessResult, session?: SessionRequest): AgentResult;
}

/** 診断に使える出力は CLI が選ぶ。本文と構造化エラーを混ぜない。 */
interface DecodedOutput {
  session: string | null;
  text: string;
  errors: string[];
  diagnosticText: string;
  failed?: boolean;
}

const claude: AgentAdapter = {
  buildArgv(choice, prompt, session) {
    const conversation = !session
      ? []
      : session.kind === "start"
        ? ["--session-id", session.id]
        : ["--resume", session.id];
    return printArgv("claude", choice, prompt, conversation);
  },
  readResult(result, session) {
    return interpretResult(result, {
      session: session?.id ?? null,
      text: result.stdout,
      errors: [],
      diagnosticText: result.stdout,
    });
  },
};

const agy: AgentAdapter = {
  buildArgv(choice, prompt, session) {
    const conversation = session
      ? [
          ...(session.kind === "resume" ? ["--conversation", session.id] : []),
          "--output-format",
          "json",
        ]
      : [];
    return printArgv("agy", choice, prompt, conversation);
  },
  readResult(result, session) {
    let conversation: string | null = null;
    let text = result.stdout;
    if (session) {
      try {
        const out: unknown = JSON.parse(result.stdout);
        if (isRecord(out)) {
          conversation =
            typeof out.conversation_id === "string" ? out.conversation_id || null : null;
          if (typeof out.response === "string") text = out.response;
        }
      } catch {
        // JSON を読めなければ、本文は生の出力を残し、会話 ID は null にする。
      }
    }
    const events = jsonEvents(result.stdout);
    return interpretResult(result, {
      session: conversation,
      text,
      errors: events.map(errorMessage),
      diagnosticText: events.length > 0 ? "" : result.stdout,
    });
  },
};

const codex: AgentAdapter = {
  buildArgv(choice, prompt, session) {
    return [
      "codex",
      "exec",
      ...(session?.kind === "resume" ? ["resume"] : []),
      ...modelArgs(choice),
      ...(choice.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(choice.effort)}`] : []),
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      ...(session?.kind === "resume" ? [session.id] : []),
      // オプションに見えるプロンプトも位置引数として渡す。
      "--",
      prompt,
    ];
  },
  readResult(result, session) {
    const events = jsonEvents(result.stdout);
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
    const errors = events.filter((e) => e.type === "turn.failed" || e.type === "error");
    return interpretResult(result, {
      session:
        typeof thread?.thread_id === "string"
          ? thread.thread_id
          : session?.kind === "resume"
            ? session.id
            : null,
      text: messages.at(-1) ?? "",
      errors: errors.map(errorMessage),
      diagnosticText: "",
      failed: errors.some((e) => e.type === "turn.failed"),
    });
  },
};

const ADAPTERS = { claude, agy, codex } satisfies Record<AgentName, AgentAdapter>;

export function getAgentAdapter(agent: AgentName): AgentAdapter {
  return ADAPTERS[agent];
}

/** CLI の権限確認・モデル・effort・プロンプトの配置を共有する。 */
function printArgv(
  command: "claude" | "agy",
  choice: ModelChoice,
  prompt: string,
  conversation: string[],
): string[] {
  return [
    command,
    ...modelArgs(choice),
    ...conversation,
    ...(choice.effort ? ["--effort", choice.effort] : []),
    "--dangerously-skip-permissions",
    // agy の -p は直後の引数をプロンプトとして読むので、必ず末尾に置く。
    "-p",
    prompt,
  ];
}

function modelArgs(choice: ModelChoice): string[] {
  return choice.model ? ["--model", choice.model] : [];
}

function interpretResult(result: AgentProcessResult, output: DecodedOutput): AgentResult {
  let failure: FailureKind | null = null;
  if (result.code !== 0 || output.failed) {
    failure =
      result.code === 127 || result.code >= 128
        ? "error"
        : classifyDiagnostics([result.stderr, ...output.errors].join("\n"), output.diagnosticText);
  }
  return { session: output.session, text: output.text, failure };
}

/** CLI が抽出した診断から利用不能だけを識別する。エージェント名・会話の形式は知らない。 */
function classifyDiagnostics(trusted: string, stdout: string): FailureKind {
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

/** 非対話で 1 ターン実行するコマンド。 */
export function buildArgv(inv: Invocation, prompt: string, session?: SessionRequest): string[] {
  return getAgentAdapter(inv.agent).buildArgv(inv, prompt, session);
}

/** 会話 ID と本文の読み取り。CLI の出力を確認する場合に使う。 */
export function readSessionOutput(
  agent: AgentName,
  session: SessionRequest | undefined,
  stdout: string,
): { session: string | null; text: string } {
  const out = getAgentAdapter(agent).readResult({ code: 0, stdout, stderr: "" }, session);
  return { session: out.session, text: out.text };
}

/** CLI の終了結果から、通常の失敗と利用不能を区別する。 */
export function classifyFailure(agent: AgentName, result: AgentProcessResult): FailureKind | null {
  return getAgentAdapter(agent).readResult(result).failure;
}
