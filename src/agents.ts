/**
 * エージェント CLI ごとの違いはここだけに閉じる。
 * 他のモジュールは「どのエージェントに、どのモデルで、どのプロンプトを渡すか」しか知らない。
 */

export const AGENTS = ["claude", "agy", "copilot"] as const;
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
 * - start: 新しい会話を始める。claude と copilot には id を渡す。agy は ID を先に決められないので、出力から読む
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
    case "copilot":
      // --resume は値を省略できるので、= でつなぐ。
      return s.kind === "start" ? ["--session-id", s.id] : [`--resume=${s.id}`];
  }
}

/** 会話を引き継いだ実行の標準出力から、会話 ID と本文を読む。ID が読めなければ session は null。 */
export function readSessionOutput(
  agent: AgentName,
  s: SessionRequest,
  stdout: string,
): { session: string | null; text: string } {
  if (agent !== "agy") return { session: s.id, text: stdout };
  try {
    const out: unknown = JSON.parse(stdout);
    const field = (k: string) => {
      const v =
        typeof out === "object" && out !== null ? (out as Record<string, unknown>)[k] : null;
      return typeof v === "string" ? v : null;
    };
    return { session: field("conversation_id") || null, text: field("response") ?? stdout };
  } catch {
    return { session: null, text: stdout };
  }
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
    case "copilot":
      return [
        "copilot",
        ...model,
        ...conversation,
        ...effort("--reasoning-effort"),
        "--yolo",
        "-p",
        prompt,
      ];
  }
}
