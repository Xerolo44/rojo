// Stand-in for the Rojo Studio plugin: polls the hub like
// plugin/src/RemoteControl/init.lua does and simulates connecting.

import { randomUUID } from "node:crypto";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function startFakePlugin({ controlPort, placeName = "Test Place", placeId = 0, intervalMs = 80, confirm = false }) {
  const state = {
    instanceId: randomUUID(),
    status: { appStatus: "NotConnected", host: "localhost", port: "34872" },
    results: [],
    received: [],
  };
  let stopped = false;

  function apply(command) {
    state.received.push(command);
    if (command.type === "connect") {
      const host = command.host ?? "localhost";
      if (!LOOPBACK.has(host)) {
        state.results.push({ id: command.id, ok: false, error: "host is not a loopback address" });
        return;
      }
      state.status = { appStatus: "Connecting", host, port: String(command.port) };
      setTimeout(() => {
        state.status = confirm
          ? { appStatus: "Confirming", host, port: String(command.port) }
          : { appStatus: "Connected", host, port: String(command.port), address: `${host}:${command.port}`, projectName: "Proj" };
      }, 150);
    } else if (command.type === "disconnect") {
      state.status = { ...state.status, appStatus: "NotConnected", address: undefined };
    } else if (command.type === "confirm") {
      if (state.status.appStatus !== "Confirming") {
        state.results.push({ id: command.id, ok: false, error: "no sync is waiting for confirmation" });
        return;
      }
      const { host, port } = state.status;
      state.status =
        command.action === "Accept"
          ? { appStatus: "Connected", host, port, address: `${host}:${port}`, projectName: "Proj" }
          : { appStatus: "Error", host, port, errorMessage: "Aborted Rojo sync operation" };
    }
    state.results.push({ id: command.id, ok: true });
  }

  async function loop() {
    while (!stopped) {
      try {
        const sent = state.results.length;
        const res = await fetch(`http://127.0.0.1:${controlPort}/plugin/poll`, {
          method: "POST",
          body: JSON.stringify({
            protocolVersion: 1,
            instanceId: state.instanceId,
            pluginVersion: "7.7.1",
            placeName,
            placeId,
            gameId: 0,
            status: state.status,
            results: state.results,
          }),
        });
        const body = await res.json();
        state.results.splice(0, sent);
        for (const command of body.commands ?? []) apply(command);
      } catch {
        // hub not up yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  loop();

  return {
    state,
    stop() {
      stopped = true;
    },
  };
}
