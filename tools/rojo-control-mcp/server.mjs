#!/usr/bin/env node
// Stdio MCP server that switches the Rojo Studio plugin between `rojo serve`
// instances. It needs no dependencies: MCP over stdio is newline-delimited
// JSON-RPC, and only a handful of methods are required for tools.

import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { createHub, DEFAULT_CONTROL_PORT, resolveTarget, SERVICE_NAME, summary } from "./hub.mjs";

const CONTROL_PORT = Number(process.env.ROJO_CONTROL_PORT) || DEFAULT_CONTROL_PORT;
const BASE = `http://127.0.0.1:${CONTROL_PORT}`;
const SERVER_INFO = { name: "rojo-control", version: "0.1.0" };

let ownHub = null;

// Starts the hub in this process unless another process already runs one.
// Several Claude sessions each start their own MCP server; whichever binds the
// port first serves everyone, the others talk to it over HTTP.
export async function ensureHub() {
  if (await hubIsHealthy()) return;
  const hub = createHub({ port: CONTROL_PORT });
  try {
    await hub.listen();
    ownHub = hub;
    log(`control endpoint listening on ${BASE}`);
  } catch (err) {
    if (err.code === "EADDRINUSE" && (await hubIsHealthy())) return; // lost a race, fine
    if (err.code === "EADDRINUSE") {
      throw new Error(`port ${CONTROL_PORT} is used by another program; set ROJO_CONTROL_PORT`);
    }
    throw err;
  }
}

async function hubIsHealthy() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    return body.service === SERVICE_NAME;
  } catch {
    return false;
  }
}

async function api(path, body) {
  await ensureHub();
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(70_000),
  });
  const payload = await res.json();
  if (!res.ok) {
    const err = new Error(payload.error ?? `HTTP ${res.status}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The plugin backs off to a 10 s poll interval while no hub is reachable, so a
// freshly started hub may need a moment before any Studio shows up.
async function listStudios({ waitMs = 12_000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { studios } = await api("/api/studios");
    if (studios.length > 0 || Date.now() >= deadline) return studios;
    await sleep(500);
  }
}

async function findStudio(studio) {
  const studios = await listStudios();
  const target = resolveTarget(studios, studio);
  if (target.error) {
    const err = new Error(target.error);
    err.payload = { studios: studios.map(summary) };
    throw err;
  }
  return target.instance;
}

async function waitForStatus(instanceId, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { studios } = await api("/api/studios");
    last = studios.find((s) => s.instanceId === instanceId) ?? null;
    if (last && done(last.status ?? {})) return { finished: true, studio: last };
    await sleep(300);
  }
  return { finished: false, studio: last };
}

async function sendCommand(studio, command) {
  const target = await findStudio(studio);
  const result = await api("/api/command", { ...command, studio: target.instanceId });
  if (!result.ok) {
    throw Object.assign(new Error(result.error ?? "command failed"), { payload: { studio: summary(target) } });
  }
  return target;
}

const studioParam = {
  type: "string",
  description:
    "Which Studio window to control: instanceId, placeId (most reliable), or part of the published place name or game.Name. Optional when only one Studio is polling.",
};

export const TOOLS = [
  {
    name: "rojo_list_studios",
    description: "List Studio windows whose Rojo plugin polls the control endpoint, with their Rojo connection status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const studios = await listStudios({ waitMs: 3_000 });
      return { studios };
    },
  },
  {
    name: "rojo_status",
    description: "Show the Rojo plugin status of one Studio window (appStatus, project, address, error).",
    inputSchema: { type: "object", properties: { studio: studioParam }, additionalProperties: false },
    async run({ studio }) {
      return await findStudio(studio);
    },
  },
  {
    name: "rojo_connect",
    description:
      "Disconnect the Rojo plugin from its current server and connect it to `rojo serve` on the given port (loopback hosts only). Waits until the plugin is Connected, needs confirmation, or reports an error.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1, maximum: 65535, description: "Port of the `rojo serve` to connect to." },
        host: { type: "string", description: "localhost (default), 127.0.0.1 or ::1." },
        studio: studioParam,
        timeoutSeconds: { type: "number", description: "How long to wait for the connection (default 30)." },
      },
      required: ["port"],
      additionalProperties: false,
    },
    async run({ port, host, studio, timeoutSeconds = 30 }) {
      const target = await sendCommand(studio, { type: "connect", port, host });
      const wanted = `:${port}`;
      const { finished, studio: after } = await waitForStatus(
        target.instanceId,
        (s) =>
          s.appStatus === "Error" ||
          s.appStatus === "Confirming" ||
          (s.appStatus === "Connected" && String(s.address ?? "").endsWith(wanted)),
        timeoutSeconds * 1000,
      );
      const status = after?.status ?? {};
      return {
        connected: status.appStatus === "Connected",
        timedOut: !finished,
        hint:
          status.appStatus === "Confirming"
            ? "The plugin waits for the initial sync to be confirmed; call rojo_confirm with Accept or Abort."
            : undefined,
        studio: after,
      };
    },
  },
  {
    name: "rojo_disconnect",
    description: "Disconnect the Rojo plugin of one Studio window from its server.",
    inputSchema: { type: "object", properties: { studio: studioParam }, additionalProperties: false },
    async run({ studio }) {
      const target = await sendCommand(studio, { type: "disconnect" });
      const { studio: after } = await waitForStatus(
        target.instanceId,
        (s) => s.appStatus === "NotConnected",
        10_000,
      );
      return { studio: after };
    },
  },
  {
    name: "rojo_confirm",
    description:
      "Answer the plugin's initial-sync confirmation (only when appStatus is Confirming). Accept applies the server's changes to the place; Abort cancels; Reject needs two-way sync.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["Accept", "Abort", "Reject"] }, studio: studioParam },
      required: ["action"],
      additionalProperties: false,
    },
    async run({ action, studio }) {
      const target = await sendCommand(studio, { type: "confirm", action });
      const { studio: after } = await waitForStatus(
        target.instanceId,
        (s) => s.appStatus !== "Confirming",
        30_000,
      );
      return { studio: after };
    },
  },
];

// --- JSON-RPC over stdio -------------------------------------------------

function log(message) {
  // stdout carries the protocol; diagnostics go to stderr.
  process.stderr.write(`[rojo-control] ${message}\n`);
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

export async function handleMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${params?.name}`), { rpcCode: -32602 });
      try {
        const result = await tool.run(params.arguments ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const text = JSON.stringify({ error: err.message, ...(err.payload ?? {}) }, null, 2);
        return { content: [{ type: "text", text }], isError: true };
      }
    }
    default:
      if (!isRequest) return undefined; // notifications such as notifications/initialized
      throw Object.assign(new Error(`method not found: ${method}`), { rpcCode: -32601 });
  }
}

function main() {
  // Start the hub right away so plugins can register before the first tool call.
  ensureHub().catch((err) => log(err.message));

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (line.trim() === "") return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return replyError(null, -32700, "parse error");
    }
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await handleMessage(msg);
      if (isRequest) reply(msg.id, result ?? {});
    } catch (err) {
      if (isRequest) replyError(msg.id, err.rpcCode ?? -32603, err.message);
    }
  });
  rl.on("close", async () => {
    if (ownHub) await ownHub.close();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
