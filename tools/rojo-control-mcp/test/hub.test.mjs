import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHub, resolveTarget } from "../hub.mjs";
import { startFakePlugin } from "./fake-plugin.mjs";

async function withHub(fn) {
  const hub = createHub({ port: 0 });
  const port = await hub.listen();
  try {
    await fn(port);
  } finally {
    await hub.close();
  }
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
};

test("a polling plugin shows up in /api/studios", async () => {
  await withHub(async (port) => {
    const plugin = startFakePlugin({ controlPort: port, placeName: "Monsters and Masterpieces" });
    try {
      assert.ok(
        await waitFor(async () => {
          const r = await fetch(`http://127.0.0.1:${port}/api/studios`).then((x) => x.json());
          return r.studios.some((s) => s.placeName === "Monsters and Masterpieces");
        }),
      );
    } finally {
      plugin.stop();
    }
  });
});

test("connect command is delivered and acknowledged", async () => {
  await withHub(async (port) => {
    const plugin = startFakePlugin({ controlPort: port });
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/studios`).then((x) => x.json())).studios.length);
      const r = await post(port, "/api/command", { type: "connect", port: 34899 });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.acknowledged, true);
      assert.equal(plugin.state.received[0].port, 34899);
      assert.ok(await waitFor(() => plugin.state.status.appStatus === "Connected"));
    } finally {
      plugin.stop();
    }
  });
});

test("command to a studio that stops polling times out and is dropped", async () => {
  await withHub(async (port) => {
    const plugin = startFakePlugin({ controlPort: port });
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/studios`).then((x) => x.json())).studios.length);
    plugin.stop();
    await new Promise((r) => setTimeout(r, 150));
    const r = await post(port, "/api/command", { type: "disconnect", ackTimeoutMs: 600 });
    assert.equal(r.body.acknowledged, false);
    assert.equal(r.body.ok, false);
  });
});

test("plugin rejection is passed through", async () => {
  await withHub(async (port) => {
    const plugin = startFakePlugin({ controlPort: port });
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/studios`).then((x) => x.json())).studios.length);
      const r = await post(port, "/api/command", { type: "connect", port: 1, host: "evil.example" });
      assert.equal(r.body.ok, false);
      assert.match(r.body.error, /loopback/);
    } finally {
      plugin.stop();
    }
  });
});

test("several studios require a selector", async () => {
  await withHub(async (port) => {
    const a = startFakePlugin({ controlPort: port, placeName: "Monsters and Masterpieces" });
    const b = startFakePlugin({ controlPort: port, placeName: "Untitled Experience" });
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/studios`).then((x) => x.json())).studios.length === 2);
      const ambiguous = await post(port, "/api/command", { type: "disconnect" });
      assert.equal(ambiguous.status, 409);
      const picked = await post(port, "/api/command", { type: "connect", port: 34874, studio: "monsters" });
      assert.equal(picked.body.ok, true);
      assert.equal(a.state.received.length, 1);
      assert.equal(b.state.received.length, 0);
    } finally {
      a.stop();
      b.stop();
    }
  });
});

test("resolveTarget prefers exact matches", () => {
  const live = [
    { instanceId: "1", placeName: "Game", placeId: 5 },
    { instanceId: "2", placeName: "Game Test", placeId: 6 },
  ];
  assert.equal(resolveTarget(live, "Game").instance.instanceId, "1");
  assert.equal(resolveTarget(live, "test").instance.instanceId, "2");
  assert.equal(resolveTarget(live, "6").instance.instanceId, "2");
  assert.equal(resolveTarget(live, "gam").status, 409);
  assert.equal(resolveTarget(live, "nope").status, 404);
  assert.equal(resolveTarget([], undefined).status, 404);

  const studio = [
    { instanceId: "a", placeName: "Monsters and Masterpieces", dataModelName: "Place1", placeId: 133163803510735 },
    { instanceId: "b", placeName: "Place1", dataModelName: "Place1", placeId: 0 },
  ];
  assert.equal(resolveTarget(studio, "Monsters and Masterpieces").instance.instanceId, "a");
  assert.equal(resolveTarget(studio, "133163803510735").instance.instanceId, "a");
  assert.equal(resolveTarget(studio, "Place1").status, 409);
});

test("browser-style requests are refused", async () => {
  await withHub(async (port) => {
    const withOrigin = await fetch(`http://127.0.0.1:${port}/api/studios`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(withOrigin.status, 403);

    // fetch() cannot override Host, so use a raw request for the rebinding case.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/studios", headers: { host: "evil.example:80" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});
