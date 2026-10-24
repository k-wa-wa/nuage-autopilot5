/**
 * エージェント CLI ごとの違いはここだけに閉じる。
 * 他のモジュールは「どのエージェントに、どのプロンプトを渡すか」しか知らない。
 */

export const AGENTS = ["claude", "agy", "copilot"] as const;
export type AgentName = (typeof AGENTS)[number];

export interface AgentSpec {
  agent: AgentName;
  model?: string;
}

/** `agy` や `agy:gemini-3.8-flash-high` を読む。 */
export function parseAgentSpec(text: string): AgentSpec {
  const [agent, ...rest] = text.trim().split(":");
  if (!AGENTS.includes(agent as AgentName)) {
    throw new Error(`unknown agent: ${agent}（${AGENTS.join(" / ")}）`);
  }
  const model = rest.join(":");
  return model ? { agent: agent as AgentName, model } : { agent: agent as AgentName };
}

export function formatAgentSpec(spec: AgentSpec): string {
  return spec.model ? `${spec.agent}:${spec.model}` : spec.agent;
}

/**
 * 非対話で 1 ターン実行するコマンド。
 * 人間は不在なので、どのエージェントも権限確認を飛ばす。
 */
export function buildArgv(spec: AgentSpec, prompt: string): string[] {
  const model = spec.model ? ["--model", spec.model] : [];
  switch (spec.agent) {
    case "claude":
      return ["claude", ...model, "--dangerously-skip-permissions", "-p", prompt];
    case "agy":
      // agy の -p は直後の引数をプロンプトとして読むので、必ず末尾に置く。
      return ["agy", ...model, "--dangerously-skip-permissions", "-p", prompt];
    case "copilot":
      return ["copilot", ...model, "--yolo", "-p", prompt];
  }
}
