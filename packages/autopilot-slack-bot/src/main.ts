#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadSlackBotConfig } from "./config.ts";
import { runSlackBot } from "./runner.ts";

const USAGE = `usage: autopilot-slack-bot check-config --file <path>
       autopilot-slack-bot run --config <path>`;

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  let values: {
    file?: string;
    config?: string;
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
        const cfg = loadSlackBotConfig(values.file);
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
      let cfg: ReturnType<typeof loadSlackBotConfig>;
      try {
        cfg = loadSlackBotConfig(values.config);
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
      return await runSlackBot({ config: cfg });
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
