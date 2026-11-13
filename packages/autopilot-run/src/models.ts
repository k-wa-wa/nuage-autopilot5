import { existsSync, readFileSync } from "node:fs";
import {
  AGENTS,
  type AgentName,
  type AgentSpec,
  formatAgentSpec,
  formatModelChoice,
  type Invocation,
  type ModelChoice,
  parseModelChoice,
} from "./agents.ts";
import { REVIEW_PERSPECTIVES, type ReviewPerspectiveSlug } from "./prompts.ts";

/**
 * どの作業を、どのくらいの賢さで行うか。
 *
 * - 作業ごとの賢さ（段階）はここで決める。設計なので、めったに変わらない。
 * - 段階ごとの具体的なモデルは models.yaml が決める。モデルは頻繁に変わるので、ホスト側の 1 ファイルに集める。
 *
 * コードには実在のモデル名を書かない。
 */

export const LEVELS = ["high", "standard", "light"] as const;
export type Level = (typeof LEVELS)[number];

/** 実装と修正の賢さの既定。仕事の難しさは窓口が会話から分かるので、--level で変えられる。 */
export const DEFAULT_LEVEL: Level = "high";

/** 実装・修正以外の作業の賢さ。レビュー・ゲートは見落としが一番高くつき、要約は差分とログをまとめるだけ。 */
const FIXED_LEVELS = {
  review: "high",
  gate: "high",
  summarize: "light",
} as const satisfies Record<string, Level>;

export const MODELS_PATH = "/etc/autopilot5/models.yaml";

/** エージェント → 段階 → 前から順に試すモデル。 */
export interface RoleTable {
  impl?: AgentName[];
  review?: AgentName[];
}

export const DEFAULT_ROLES = {
  impl: ["agy", "codex", "claude"],
  review: ["claude", "codex", "agy"],
} as const satisfies Record<keyof RoleTable, readonly AgentName[]>;

export type ModelTable = Partial<Record<AgentName, Partial<Record<Level, ModelChoice[]>>>> & {
  roles?: RoleTable;
};

/** models.yaml を読む。書き間違いは黙って無視せず、場所を添えて拒否する。 */
export function parseModelTable(text: string): ModelTable {
  const raw: unknown = Bun.YAML.parse(text);
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("models.yaml: エージェントごとの表で書く");

  const table: ModelTable = {};
  for (const [agent, levels] of Object.entries(raw)) {
    if (agent === "roles") {
      if (!isRecord(levels)) throw new Error("models.yaml: roles は impl / review の表で書く");
      const roles: RoleTable = {};
      for (const [role, agents] of Object.entries(levels)) {
        if (role !== "impl" && role !== "review")
          throw new Error(`models.yaml: 知らない担当: roles.${role}`);
        if (
          !Array.isArray(agents) ||
          agents.length === 0 ||
          agents.some((a) => !AGENTS.includes(a)) ||
          new Set(agents).size !== agents.length
        )
          throw new Error(
            `models.yaml: roles.${role} は ${AGENTS.join(" / ")} を重複なく 1 つ以上並べる`,
          );
        roles[role] = agents;
      }
      table.roles = roles;
      continue;
    }
    if (!AGENTS.includes(agent as AgentName)) {
      throw new Error(`models.yaml: 知らないエージェント: ${agent}（${AGENTS.join(" / ")}）`);
    }
    if (levels === null) continue;
    if (!isRecord(levels)) throw new Error(`models.yaml: ${agent} は段階ごとの表で書く`);
    const row: Partial<Record<Level, ModelChoice[]>> = {};
    for (const [level, list] of Object.entries(levels)) {
      if (!LEVELS.includes(level as Level)) {
        throw new Error(`models.yaml: ${agent} の知らない段階: ${level}（${LEVELS.join(" / ")}）`);
      }
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`models.yaml: ${agent}.${level} はモデルを 1 つ以上並べたリストで書く`);
      }
      row[level as Level] = list.map((m, i) => {
        if (typeof m !== "string") {
          throw new Error(
            `models.yaml: ${agent}.${level}[${i}] は "MODEL" か "MODEL@EFFORT" で書く`,
          );
        }
        try {
          return parseModelChoice(m);
        } catch (e) {
          throw new Error(`models.yaml: ${agent}.${level}[${i}]: ${(e as Error).message}`);
        }
      });
    }
    table[agent as AgentName] = row;
  }
  return table;
}

/** ファイルが無ければ null（各 CLI の既定モデルで動く）。 */
export function loadModelTable(path: string): ModelTable | null {
  if (!existsSync(path)) return null;
  return parseModelTable(readFileSync(path, "utf8"));
}

/** 担当を、試す順の実行の並びにする。モデルを明示した担当には段階を使わない。 */
export function resolveChain(spec: AgentSpec, level: Level, table: ModelTable): Invocation[] {
  const models = spec.models.length > 0 ? spec.models : (table[spec.agent]?.[level] ?? []);
  return (models.length > 0 ? models : [{}]).map((m) => ({ agent: spec.agent, ...m }));
}

/** 名前付きの担当。name はログとレビューのファイル名に使う。 */
export interface Assignee {
  name: string;
  chain: Invocation[];
}

export interface ReviewerAssignee extends Assignee {
  perspective: ReviewPerspectiveSlug;
}

export interface Assignment {
  implement: Assignee;
  fix: Assignee;
  summarize: Assignee;
  reviewers: ReviewerAssignee[];
  gate: Assignee;
}

/** 観点ごとに試す担当の並びを決める。i 番目から始め、残りは並びの順に試す。 */
export function rotateReviewers(agents: readonly AgentName[], index: number): AgentName[] {
  if (agents.length === 0) return [];
  const start = index % agents.length;
  const first = agents[start]!;
  const rest = agents.filter((_, idx) => idx !== start);
  return [first, ...rest];
}

/** 作業ごとに、誰がどのモデルの並びで行うかを決める。 */
export function assignRoles(
  opts: { impl?: AgentSpec; reviewers?: AgentSpec[]; level: Level },
  table: ModelTable,
): Assignment {
  const as = (spec: AgentSpec, level: Level): Assignee => ({
    name: formatAgentSpec(spec),
    chain: resolveChain(spec, level, table),
  });
  const configured = (role: keyof RoleTable, level: Level): Assignee => {
    const agents = table.roles?.[role] ?? DEFAULT_ROLES[role];
    return {
      name: agents[0]!,
      chain: agents.flatMap((agent) => resolveChain({ agent, models: [] }, level, table)),
    };
  };
  const implement = opts.impl ? as(opts.impl, opts.level) : configured("impl", opts.level);

  let reviewers: ReviewerAssignee[];
  let gate: Assignee;
  if (opts.reviewers && opts.reviewers.length > 0) {
    reviewers = REVIEW_PERSPECTIVES.map((p, i) => {
      const spec = opts.reviewers![i % opts.reviewers!.length]!;
      return {
        name: formatAgentSpec(spec),
        perspective: p.slug,
        chain: resolveChain(spec, FIXED_LEVELS.review, table),
      };
    });
    const gateSpec = opts.reviewers[0]!;
    gate = {
      name: formatAgentSpec(gateSpec),
      chain: resolveChain(gateSpec, FIXED_LEVELS.gate, table),
    };
  } else {
    const configuredAgents = table.roles?.review ?? DEFAULT_ROLES.review;
    reviewers = REVIEW_PERSPECTIVES.map((p, i) => {
      const order = rotateReviewers(configuredAgents, i);
      return {
        name: order[0]!,
        perspective: p.slug,
        chain: order.flatMap((agent) =>
          resolveChain({ agent, models: [] }, FIXED_LEVELS.review, table),
        ),
      };
    });
    gate = {
      name: configuredAgents[0]!,
      chain: configuredAgents.flatMap((agent) =>
        resolveChain({ agent, models: [] }, FIXED_LEVELS.gate, table),
      ),
    };
  }

  return {
    implement,
    fix: implement,
    summarize: opts.impl
      ? as(opts.impl, FIXED_LEVELS.summarize)
      : configured("impl", FIXED_LEVELS.summarize),
    reviewers,
    gate,
  };
}

/** `autopilot-run models` の表示。 */
export function formatModelTable(table: ModelTable): string {
  const lines: string[] = [
    "roles:",
    `  impl     ${(table.roles?.impl ?? DEFAULT_ROLES.impl).join(" → ")}`,
    `  review   ${(table.roles?.review ?? DEFAULT_ROLES.review).join(" → ")}`,
  ];
  for (const agent of AGENTS) {
    const row = table[agent];
    if (!row) continue;
    lines.push(`${agent}:`);
    for (const level of LEVELS) {
      const list = row[level];
      if (list) lines.push(`  ${level.padEnd(8)} ${list.map(formatModelChoice).join(" → ")}`);
    }
  }
  return lines.join("\n");
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
