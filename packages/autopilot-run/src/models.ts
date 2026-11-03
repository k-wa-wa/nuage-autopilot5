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

/** 実装・修正以外の作業の賢さ。レビューは見落としが一番高くつき、要約は差分とログをまとめるだけ。 */
const FIXED_LEVELS = { review: "high", summarize: "light" } as const satisfies Record<
  string,
  Level
>;

export const MODELS_PATH = "/etc/autopilot5/models.yaml";

/** エージェント → 段階 → 前から順に試すモデル。 */
export type ModelTable = Partial<Record<AgentName, Partial<Record<Level, ModelChoice[]>>>>;

/** models.yaml を読む。書き間違いは黙って無視せず、場所を添えて拒否する。 */
export function parseModelTable(text: string): ModelTable {
  const raw: unknown = Bun.YAML.parse(text);
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("models.yaml: エージェントごとの表で書く");

  const table: ModelTable = {};
  for (const [agent, levels] of Object.entries(raw)) {
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

export interface Assignment {
  implement: Assignee;
  fix: Assignee;
  summarize: Assignee;
  reviewers: Assignee[];
}

/** 作業ごとに、誰がどのモデルの並びで行うかを決める。 */
export function assignRoles(
  opts: { impl: AgentSpec; reviewers: AgentSpec[]; level: Level },
  table: ModelTable,
): Assignment {
  const as = (spec: AgentSpec, level: Level): Assignee => ({
    name: formatAgentSpec(spec),
    chain: resolveChain(spec, level, table),
  });
  return {
    implement: as(opts.impl, opts.level),
    fix: as(opts.impl, opts.level),
    summarize: as(opts.impl, FIXED_LEVELS.summarize),
    reviewers: opts.reviewers.map((r) => as(r, FIXED_LEVELS.review)),
  };
}

/** `autopilot-run models` の表示。 */
export function formatModelTable(table: ModelTable): string {
  const lines: string[] = [];
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
