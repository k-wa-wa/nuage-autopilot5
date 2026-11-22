#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadTaskConfig } from "./config.ts";
import { runTask } from "./runner.ts";

const USAGE = `usage: autopilot-task check-config --file <path>
       autopilot-task run --config <path> [--event-file <path>]`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  let values: {
    file?: string;
    config?: string;
    "event-file"?: string;
    help: boolean;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        file: { type: "string" },
        config: { type: "string" },
        "event-file": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    throw new UsageError(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const sub = positionals[0];
  switch (sub) {
    case "check-config": {
      if (!values.file) {
        throw new UsageError(`--file <path> を指定すること\n${USAGE}`);
      }
      try {
        const cfg = loadTaskConfig(values.file);
        console.log(`${cfg.name}: ok`);
        return 0;
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
    }
    case "run": {
      if (!values.config) {
        throw new UsageError(`--config <path> を指定すること\n${USAGE}`);
      }
      let cfg: ReturnType<typeof loadTaskConfig>;
      try {
        cfg = loadTaskConfig(values.config);
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
      let eventContent: string | null = null;
      if (values["event-file"] !== undefined) {
        const ef = values["event-file"];
        if (!existsSync(ef) || !statSync(ef).isFile()) {
          throw new UsageError(`--event-file が見つからない: ${ef}`);
        }
        eventContent = readFileSync(ef, "utf8");
      }
      return await runTask({ config: cfg, eventContent });
    }
    default:
      throw new UsageError(USAGE);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      if (e instanceof UsageError) {
        console.error(e.message);
        process.exit(2);
      }
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
