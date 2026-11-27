import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

export interface RecordedCall {
  agent: string;
  args: string[];
  prompt: string;
  cwd: string;
  envOrca: string[];
  envSlackTokens: string[];
}

export interface PostedMessage {
  channel: string;
  thread_ts?: string;
  text: string;
}

export interface WorldCleanup {
  dir: string;
  servers: Array<{ stop: (closeActive?: boolean) => void }>;
  restoreEnv: () => void;
}

export function cleanupWorlds(cleanups: WorldCleanup[]): void {
  for (const c of cleanups.splice(0)) {
    for (const s of c.servers) s.stop(true);
    c.restoreEnv();
    rmSync(c.dir, { recursive: true, force: true });
  }
}

export function setupWorld(cleanups: WorldCleanup[], agentScript: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "autopilot-slack-e2e-"));
  const bin = join(root, "bin");
  const stateDir = join(root, "state");
  const callsPath = join(root, "calls.jsonl");
  const counterPath = join(root, "counter.txt");
  const scriptPath = join(root, "agent-script.json");
  const soul = join(root, "SOUL.md");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(soul, "# Test Slack Soul\n調査結果をスレッドへ報告すること。\n");
  writeFileSync(scriptPath, JSON.stringify(agentScript));
  writeFileSync(counterPath, "0");

  const installFakeAgent = (name: "claude" | "agy" | "codex") => {
    const wrapper = join(bin, name);
    writeFileSync(
      wrapper,
      `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const envOrca = Object.keys(process.env).filter((k) => k.startsWith("ORCA_"));
const envSlackTokens = Object.keys(process.env).filter((k) => /^SLACK_.*_TOKEN$/.test(k));
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ agent: ${JSON.stringify(name)}, args, prompt, cwd: process.cwd(), envOrca, envSlackTokens }) + "\\n");

const idx = Number(readFileSync(${JSON.stringify(counterPath)}, "utf8")) + 1;
writeFileSync(${JSON.stringify(counterPath)}, String(idx));
const script = JSON.parse(readFileSync(${JSON.stringify(scriptPath)}, "utf8"));
const byPrompt = Object.entries(script.byPrompt ?? {}).find(([k]) => prompt.includes(k))?.[1];
const step = byPrompt ?? script[String(idx)] ?? script[${JSON.stringify(name)}] ?? { code: 0, stdout: "ok" };
if (step.pidFile) {
  writeFileSync(step.pidFile, String(process.pid));
}
if (step.sleepMs) await Bun.sleep(step.sleepMs);
if (step.writeWorkdirFile) {
  writeFileSync(step.writeWorkdirFile, step.writeWorkdirContent ?? "dirty\\n");
}
if (step.stdout) process.stdout.write(step.stdout);
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.code ?? 0);
`,
    );
    chmodSync(wrapper, 0o755);
  };
  installFakeAgent("claude");
  installFakeAgent("agy");
  installFakeAgent("codex");

  const savedEnv = {
    PATH: process.env.PATH,
    AUTOPILOT_STATE_DIR: process.env.AUTOPILOT_STATE_DIR,
    AUTOPILOT_MODELS: process.env.AUTOPILOT_MODELS,
    SLACK_API_BASE_URL: process.env.SLACK_API_BASE_URL,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    ORCA_PANE_KEY: process.env.ORCA_PANE_KEY,
  };

  process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
  process.env.AUTOPILOT_STATE_DIR = stateDir;

  const servers: Array<{ stop: (closeActive?: boolean) => void }> = [];
  cleanups.push({
    dir: root,
    servers,
    restoreEnv: () => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  });

  const readCalls = (): RecordedCall[] => {
    try {
      return readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RecordedCall);
    } catch {
      return [];
    }
  };

  const setScript = (next: Record<string, unknown>) => {
    writeFileSync(scriptPath, JSON.stringify(next));
  };

  return { root, bin, stateDir, soul, servers, readCalls, setScript };
}

export function createMockSlackServer(opts: {
  botUserId?: string;
  botId?: string;
  authFailCount?: number;
  failConnectionsOpenOnCall?: number;
  threads?: Record<string, Array<Record<string, unknown>>>;
}) {
  const botUserId = opts.botUserId ?? "U_CUSTOM_BOT";
  const botId = opts.botId ?? "B_CUSTOM_BOT";
  let authFailuresRemaining = opts.authFailCount ?? 0;
  let connectionsOpenCalls = 0;

  const posted: PostedMessage[] = [];
  const repliesCalls: Array<{ channel: string; ts: string }> = [];
  const acked: string[] = [];
  const wsClients = new Set<ServerWebSocket<unknown>>();
  let postCounter = 0;

  let port = 0;
  const srv = Bun.serve({
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/slack/socket") {
        if (server.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (!url.pathname.startsWith("/slack/api/")) {
        return new Response("not found", { status: 404 });
      }
      const method = url.pathname.slice("/slack/api/".length);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

      if (method === "auth.test") {
        if (authFailuresRemaining > 0) {
          authFailuresRemaining--;
          return Response.json({ ok: false, error: "starting" }, { status: 503 });
        }
        return Response.json({ ok: true, user_id: botUserId, bot_id: botId, user: "test-bot" });
      }
      if (method === "apps.connections.open") {
        connectionsOpenCalls++;
        if (
          opts.failConnectionsOpenOnCall !== undefined &&
          connectionsOpenCalls >= opts.failConnectionsOpenOnCall
        ) {
          return Response.json({ ok: false, error: "invalid_auth" }, { status: 401 });
        }
        return Response.json({
          ok: true,
          url: `ws://127.0.0.1:${port}/slack/socket?ticket=t-${connectionsOpenCalls}`,
        });
      }
      if (method === "conversations.replies") {
        const channel = String(body.channel ?? "");
        const ts = String(body.ts ?? "");
        repliesCalls.push({ channel, ts });
        const messages = opts.threads?.[`${channel}:${ts}`] ?? [];
        return Response.json({ ok: true, messages, has_more: false });
      }
      if (method === "chat.postMessage") {
        postCounter++;
        const msg: PostedMessage = {
          channel: String(body.channel ?? ""),
          ...(typeof body.thread_ts === "string" ? { thread_ts: body.thread_ts } : {}),
          text: String(body.text ?? ""),
        };
        posted.push(msg);
        return Response.json({ ok: true, channel: msg.channel, ts: `bot.${postCounter}` });
      }
      return Response.json({ ok: false, error: "unknown_method" });
    },
    websocket: {
      open(ws) {
        wsClients.add(ws);
        ws.send(JSON.stringify({ type: "hello", num_connections: wsClients.size }));
      },
      message(_ws, raw) {
        const parsed = JSON.parse(String(raw)) as { envelope_id?: string };
        if (parsed.envelope_id) acked.push(parsed.envelope_id);
      },
      close(ws) {
        wsClients.delete(ws);
      },
    },
  });
  port = srv.port ?? 0;

  let envSeq = 0;
  const emitEvent = (event: Record<string, unknown>) => {
    const ws = [...wsClients][0];
    if (!ws) throw new Error("no ws connected");
    envSeq++;
    ws.send(
      JSON.stringify({
        envelope_id: `env-${envSeq}`,
        type: "events_api",
        payload: {
          type: "event_callback",
          event,
        },
      }),
    );
  };

  return {
    srv,
    baseUrl: `http://127.0.0.1:${srv.port}/slack/api/`,
    posted,
    repliesCalls,
    acked,
    wsClients,
    emitEvent,
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await Bun.sleep(15);
  }
  throw new Error("waitFor timeout");
}
