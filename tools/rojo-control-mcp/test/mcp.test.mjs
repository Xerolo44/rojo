// End-to-end: spawn the MCP server over stdio and drive it like Claude Code
// would, with a fake plugin polling its control endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { startFakePlugin } from "./fake-plugin.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startMcp(controlPort) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ROJO_CONTROL_PORT: String(controlPort) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args = {}) => {
    const msg = await request("tools/call", { name, arguments: args });
    return { isError: msg.result.isError === true, data: JSON.parse(msg.result.content[0].text) };
  };
  return {
    child,
    request,
    call,
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("MCP server switches the plugin between servers", async () => {
  const controlPort = await freePort();
  const mcp = startMcp(controlPort);
  const plugin = startFakePlugin({ controlPort, placeName: "Monsters and Masterpieces" });
  try {
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "rojo-control");
    mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const list = await mcp.request("tools/list", {});
    assert.deepEqual(
      list.result.tools.map((t) => t.name).sort(),
      ["rojo_confirm", "rojo_connect", "rojo_disconnect", "rojo_list_studios", "rojo_status"],
    );

    const studios = await mcp.call("rojo_list_studios");
    assert.equal(studios.data.studios.length, 1);

    const connected = await mcp.call("rojo_connect", { port: 34899, studio: "Monsters" });
    assert.equal(connected.isError, false);
    assert.equal(connected.data.connected, true);
    assert.equal(connected.data.studio.status.address, "localhost:34899");

    const switched = await mcp.call("rojo_connect", { port: 34874 });
    assert.equal(switched.data.studio.status.address, "localhost:34874");

    const status = await mcp.call("rojo_status");
    assert.equal(status.data.status.appStatus, "Connected");

    const disconnected = await mcp.call("rojo_disconnect");
    assert.equal(disconnected.data.studio.status.appStatus, "NotConnected");

    const remote = await mcp.call("rojo_connect", { port: 34872, host: "10.0.0.2" });
    assert.equal(remote.isError, true);
    assert.match(remote.data.error, /loopback/);

    const unknown = await mcp.request("nope/method", {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    plugin.stop();
    await mcp.close();
  }
});

test("confirmation flow", async () => {
  const controlPort = await freePort();
  const mcp = startMcp(controlPort);
  const plugin = startFakePlugin({ controlPort, confirm: true });
  try {
    const pending = await mcp.call("rojo_connect", { port: 34899 });
    assert.equal(pending.data.connected, false);
    assert.equal(pending.data.studio.status.appStatus, "Confirming");
    assert.ok(pending.data.hint);

    const accepted = await mcp.call("rojo_confirm", { action: "Accept" });
    assert.equal(accepted.data.studio.status.appStatus, "Connected");

    const nothingToConfirm = await mcp.call("rojo_confirm", { action: "Accept" });
    assert.equal(nothingToConfirm.isError, true);
  } finally {
    plugin.stop();
    await mcp.close();
  }
});

test("a second MCP server reuses the first one's control endpoint", async () => {
  const controlPort = await freePort();
  const first = startMcp(controlPort);
  const plugin = startFakePlugin({ controlPort });
  // Give the first server time to bind before the second one starts.
  await new Promise((r) => setTimeout(r, 400));
  const second = startMcp(controlPort);
  try {
    const result = await second.call("rojo_connect", { port: 34877 });
    assert.equal(result.data.connected, true);
  } finally {
    plugin.stop();
    await second.close();
    await first.close();
  }
});

test("the endpoint moves to a surviving MCP server when the owner exits", async () => {
  const controlPort = await freePort();
  const first = startMcp(controlPort);
  await new Promise((r) => setTimeout(r, 400));
  const second = startMcp(controlPort);
  await new Promise((r) => setTimeout(r, 200));
  await first.close();
  const plugin = startFakePlugin({ controlPort });
  try {
    const result = await second.call("rojo_connect", { port: 34878 });
    assert.equal(result.data.connected, true);
  } finally {
    plugin.stop();
    await second.close();
  }
});
