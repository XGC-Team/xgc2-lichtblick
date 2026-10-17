// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const sdkRequire = require("node:module").createRequire(require.resolve("@xgc2/xrpc"));
const { WebSocket, WebSocketServer } = sdkRequire("ws");

const { ORIGIN, startLauncher } = require("./launcher_fixture.cjs");

test("SIGTERM owns the idle proxy and view stream without consuming the drain guard", { timeout: 25000 }, async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  upstream.on("connection", (socket) => {
    socket.on("error", () => {});
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  await once(upstream, "listening");
  t.after(async () => {
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const { launcher } = await startLauncher(t, {
    controlPlane: `ws://127.0.0.1:${upstream.address().port}`,
  });
  await launcher.waitForPort();
  const page = await fetch(launcher.base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /fixture/);
  const socket = new WebSocket(`${launcher.base.replace("http:", "ws:")}/ws`, {
    origin: ORIGIN,
  });
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await once(socket, "open");
  const echoed = once(socket, "message");
  socket.send("ordinary-proxy-roundtrip");
  assert.equal((await echoed)[0].toString(), "ordinary-proxy-roundtrip");
  assert.equal(upstream.clients.size, 1);

  const transientPeer = once(upstream, "connection");
  const transient = new WebSocket(`${launcher.base.replace("http:", "ws:")}/ws`, { origin: ORIGIN });
  transient.on("error", () => {});
  await once(transient, "open");
  const [peer] = await transientPeer;
  const transientClosed = once(transient, "close");
  const peerClosed = once(peer, "close");
  transient.close();
  await Promise.all([transientClosed, peerClosed]);
  assert.equal(upstream.clients.size, 1, "ordinary peer close leaves only the held proxy");

  const request = http.get(`${launcher.base}/xgc2/view/events`, { headers: { Origin: ORIGIN } });
  t.after(() => request.destroy());
  const [response] = await once(request, "response");
  assert.equal(response.statusCode, 200);
  let frames = "";
  response.on("data", (chunk) => { frames += chunk; });
  await once(response, "data");
  const streamClosed = once(response, "close");
  const socketClosed = once(socket, "close");
  const started = performance.now();
  const exit = await launcher.stop();
  const elapsedMs = performance.now() - started;
  await Promise.all([streamClosed, socketClosed]);
  t.diagnostic(JSON.stringify({ elapsedMs, exit, upstreamClients: upstream.clients.size, stdout: launcher.output, stderr: launcher.errors }));
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.match(frames, /event: closing/);
  assert.equal(fs.existsSync(launcher.socketPath), false);
  assert.ok(elapsedMs < 3000, `known idle streams must be cancelled by their owner, took ${elapsedMs}ms`);
});

test("SIGTERM still drains an admitted ordinary HTTP response", { timeout: 10000 }, async (t) => {
  const bytes = 8 * 1024 * 1024;
  const { launcher } = await startLauncher(t, {
    prepare: ({ web }) => fs.writeFileSync(path.join(web, "ordinary.bin"), Buffer.alloc(bytes, 7)),
  });
  await launcher.waitForPort();
  const request = http.get(`${launcher.base}/ordinary.bin`);
  t.after(() => request.destroy());
  const [response] = await once(request, "response");
  response.pause();
  assert.equal(Number(response.headers["content-length"]), bytes);
  let received = 0;
  response.on("data", (chunk) => { received += chunk.length; });
  const bodyDone = once(response, "end");
  const signalled = once(launcher.child.stdout, "data");
  const stopping = launcher.stop();
  await signalled;
  response.resume();
  await bodyDone;
  assert.deepEqual(await stopping, { code: 0, signal: null });
  assert.equal(received, bytes, "normal stop must not discard admitted short HTTP work");
});
