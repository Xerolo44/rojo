// Control endpoint ("hub") that the Rojo plugin polls.
//
// Studio plugins can only make outgoing HTTP requests, so the plugin polls this
// endpoint, reports its status, and picks up queued commands. Tools (the MCP
// server) talk to the same endpoint over /api/*. Only one hub can own the port;
// every MCP server instance first checks whether a hub is already running and
// otherwise starts one itself.

import http from "node:http";
import { randomUUID } from "node:crypto";

export const SERVICE_NAME = "rojo-remote-control";
export const HUB_VERSION = "1";
export const DEFAULT_CONTROL_PORT = 34870;

// A Studio that has not polled for this long is considered gone. The plugin
// backs off to one poll every 10 s when the hub is unreachable, so this must be
// comfortably above that.
const STALE_AFTER_MS = 15_000;
const MAX_BODY_BYTES = 256 * 1024;

export function createHub({ port = DEFAULT_CONTROL_PORT, now = () => Date.now() } = {}) {
  const instances = new Map(); // instanceId -> { report, lastSeen }
  const queues = new Map(); // instanceId -> command[]
  const waiters = new Map(); // commandId -> { resolve, timer }

  function liveInstances() {
    const cutoff = now() - STALE_AFTER_MS;
    const out = [];
    for (const [id, entry] of instances) {
      if (entry.lastSeen < cutoff) {
        instances.delete(id);
        queues.delete(id);
        continue;
      }
      out.push(describe(entry));
    }
    return out;
  }

  function describe(entry) {
    const r = entry.report;
    return {
      instanceId: r.instanceId,
      placeName: r.placeName,
      placeId: r.placeId,
      gameId: r.gameId,
      pluginVersion: r.pluginVersion,
      status: r.status ?? {},
      lastSeenMsAgo: now() - entry.lastSeen,
    };
  }

  function handlePoll(report) {
    if (!report || typeof report.instanceId !== "string" || report.instanceId.length === 0) {
      return [400, { error: "instanceId missing" }];
    }
    instances.set(report.instanceId, { report, lastSeen: now() });

    for (const result of Array.isArray(report.results) ? report.results : []) {
      const waiter = result && waiters.get(result.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(result.id);
        waiter.resolve({ acknowledged: true, ok: result.ok === true, error: result.error ?? null });
      }
    }

    const commands = queues.get(report.instanceId) ?? [];
    queues.set(report.instanceId, []);
    return [200, { commands }];
  }

  async function handleCommand(body) {
    const live = liveInstances();
    const target = resolveTarget(live, body.studio);
    if (target.error) return [target.status, { error: target.error, studios: live.map(summary) }];

    const { type } = body;
    if (!["connect", "disconnect", "confirm"].includes(type)) {
      return [400, { error: `unknown command type '${type}'` }];
    }

    // The plugin validates again; this only gives callers a quick answer.
    const command = { id: randomUUID(), type };
    if (type === "connect") {
      command.port = body.port;
      if (body.host !== undefined) command.host = body.host;
    }
    if (type === "confirm") command.action = body.action;

    const ackTimeoutMs = clamp(Number(body.ackTimeoutMs) || 15_000, 500, 60_000);
    const ack = new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(command.id);
        const queue = queues.get(target.instance.instanceId);
        if (queue) {
          const index = queue.indexOf(command);
          if (index !== -1) queue.splice(index, 1);
        }
        resolve({ acknowledged: false, ok: false, error: "plugin did not pick up the command in time" });
      }, ackTimeoutMs);
      waiters.set(command.id, { resolve, timer });
    });

    if (!queues.has(target.instance.instanceId)) queues.set(target.instance.instanceId, []);
    queues.get(target.instance.instanceId).push(command);

    const result = await ack;
    return [200, { instanceId: target.instance.instanceId, commandId: command.id, ...result }];
  }

  const server = http.createServer((req, res) => {
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(text);
    };

    // Browsers send Origin on cross-site requests; nothing legitimate here does.
    // The Host check blocks DNS-rebinding pages that resolve to 127.0.0.1.
    if (req.headers.origin !== undefined) return send(403, { error: "cross-origin requests are not allowed" });
    if (!isLoopbackHostHeader(req.headers.host)) return send(403, { error: "bad host header" });

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(200, { service: SERVICE_NAME, version: HUB_VERSION, pid: process.pid });
    }
    if (req.method === "GET" && url.pathname === "/api/studios") {
      return send(200, { studios: liveInstances() });
    }

    if (req.method !== "POST" || !["/plugin/poll", "/api/command"].includes(url.pathname)) {
      return send(404, { error: "not found" });
    }

    readJson(req)
      .then(async (body) => {
        const [status, payload] =
          url.pathname === "/plugin/poll" ? handlePoll(body) : await handleCommand(body ?? {});
        send(status, payload);
      })
      .catch((err) => send(400, { error: String(err.message ?? err) }));
  });

  return {
    server,
    port,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve(server.address().port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
    },
    close() {
      for (const waiter of waiters.values()) clearTimeout(waiter.timer);
      waiters.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function summary(s) {
  return {
    instanceId: s.instanceId,
    placeName: s.placeName,
    placeId: s.placeId,
    appStatus: s.status?.appStatus,
    address: s.status?.address ?? null,
  };
}

// Picks one Studio by instance id, place id or (case-insensitive) part of the
// place name. Without a selector it only succeeds when exactly one is polling,
// so a command never lands in an unintended Studio window.
export function resolveTarget(live, selector) {
  if (live.length === 0) {
    return { status: 404, error: "no Studio with the Rojo plugin is polling the control endpoint" };
  }
  if (selector === undefined || selector === null || selector === "") {
    if (live.length === 1) return { instance: live[0] };
    return { status: 409, error: "several Studio windows are connected; pass `studio` to pick one" };
  }

  const wanted = String(selector);
  const byId = live.filter((s) => s.instanceId === wanted);
  if (byId.length === 1) return { instance: byId[0] };

  const byPlace = live.filter((s) => String(s.placeId) === wanted && wanted !== "0");
  if (byPlace.length === 1) return { instance: byPlace[0] };

  const needle = wanted.toLowerCase();
  const exactName = live.filter((s) => String(s.placeName ?? "").toLowerCase() === needle);
  if (exactName.length === 1) return { instance: exactName[0] };

  const byName = live.filter((s) => String(s.placeName ?? "").toLowerCase().includes(needle));
  if (byName.length === 1) return { instance: byName[0] };
  if (byName.length > 1 || byPlace.length > 1 || exactName.length > 1) {
    return { status: 409, error: `'${wanted}' matches several Studio windows; use the instanceId` };
  }
  return { status: 404, error: `no Studio matches '${wanted}'` };
}

function isLoopbackHostHeader(host) {
  if (typeof host !== "string") return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
