// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { ORIGIN, startLauncher } = require("./launcher_fixture.cjs");
const { EMPTY_VIEW, ViewStore, normalizeView } = require("../launcher/view-state.cjs");

const view = { layoutId: "camera-ar", followRobot: "uav1", perspective: false, visibleSurfaces: ["topics"] };

/** Opens a server-sent event stream and collects its frames. */
function openStream(base, pathname, headers = { Origin: ORIGIN }) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${pathname}`, { headers: { Accept: "text/event-stream", ...headers } }, (response) => {
      const stream = { response, status: response.statusCode, text: "", frames: [], closed: false };
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        stream.text += chunk;
        for (const block of stream.text.split("\n\n").slice(stream.frames.length, -1)) {
          const fields = Object.fromEntries(block.split("\n").filter((line) => !line.startsWith(":") && line.includes(":")).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trimStart()]));
          stream.frames.push({ comment: block.startsWith(":"), ...fields, data: fields.data === undefined ? undefined : JSON.parse(fields.data) });
        }
      });
      response.on("close", () => { stream.closed = true; });
      stream.until = async (predicate, milliseconds = 4000) => {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) { if (predicate(stream)) return stream; await delay(10); }
        throw new Error(`stream condition not met: ${JSON.stringify(stream.frames)}`);
      };
      stream.close = () => request.destroy();
      resolve(stream);
    });
    request.on("error", reject);
  });
}
async function get(base, pathname, headers = { Origin: ORIGIN }) {
  const response = await fetch(`${base}${pathname}`, { headers });
  return { status: response.status, json: await response.json(), headers: response.headers };
}

test("pages read the desired view and hear changes over the same-origin gateway", async (t) => {
  const { launcher } = await startLauncher(t);
  await launcher.waitForPort();
  const control = await launcher.control();
  assert.equal(control.described.ready, true, "ready once the page listener is up");
  assert.equal(control.described.facts.http_port, launcher.port);
  assert.deepEqual(control.described.facts.capabilities, ["view.v1"]);
  assert.equal(control.described.facts.storage, undefined);
  assert.equal(control.described.facts.assets, undefined);
  // The state a page finds when it connects: nothing stated yet.
  let page = await get(launcher.base, "/xgc2/view");
  assert.equal(page.status, 200);
  assert.deepEqual(page.json, { revision: "0", view: { layoutId: null, followRobot: null, perspective: null, visibleSurfaces: null } });
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors/);
  const early = await openStream(launcher.base, "/xgc2/view/events");
  assert.equal(early.status, 200);
  assert.equal(early.response.headers["content-type"], "text/event-stream");
  await early.until((s) => s.frames.length === 1);
  assert.deepEqual({ event: early.frames[0].event, id: early.frames[0].id, revision: early.frames[0].data.revision }, { event: "view", id: "0", revision: "0" });
  // Core states a view over the control socket: every open page is told, and so is a page that opens later.
  const stated = await control.call("PUT", "/v1/view", { body: { view } });
  assert.equal(stated.status, 200);
  await early.until((s) => s.frames.length === 2);
  assert.deepEqual(early.frames[1].data, { revision: stated.json.revision, view: normalizeView(view) });
  assert.equal(early.frames[1].id, stated.json.revision);
  page = await get(launcher.base, "/xgc2/view");
  assert.deepEqual(page.json, { revision: stated.json.revision, view: normalizeView(view) });
  const late = await openStream(launcher.base, "/xgc2/view/events");
  await late.until((s) => s.frames.length === 1);
  assert.deepEqual(late.frames[0].data, page.json);
  // A reconnecting page that is already current gets no repeat; one that is behind does.
  const current = await openStream(launcher.base, "/xgc2/view/events", { Origin: ORIGIN, "Last-Event-ID": stated.json.revision });
  await current.until((s) => s.frames.length === 1);
  assert.equal(current.frames[0].comment, true);
  const behind = await openStream(launcher.base, "/xgc2/view/events", { Origin: ORIGIN, "Last-Event-ID": "0" });
  await behind.until((s) => s.frames.length === 1);
  assert.equal(behind.frames[0].data.revision, stated.json.revision);
  // An identical statement is no change and no event.
  assert.equal((await control.call("PUT", "/v1/view", { body: { view } })).json.unchanged, true);
  await delay(100);
  assert.equal(early.frames.length, 2);
  const second = await control.call("PUT", "/v1/view", { body: { view: { ...view, followRobot: "uav2" }, expectedRevision: stated.json.revision } });
  await Promise.all([early, late, current, behind].map((s) => s.until((x) => x.frames.at(-1).data?.revision === second.json.revision)));
  assert.equal((await launcher.control()).described.facts.pages.view_streams, 4);
  for (const stream of [early, late, current, behind]) stream.close();
});

test("only a page of an allowed origin reads the view, and nothing from a page writes it", async (t) => {
  const { launcher } = await startLauncher(t);
  await launcher.waitForPort();
  assert.equal((await get(launcher.base, "/xgc2/view", { Origin: "http://evil.test" })).status, 403);
  assert.equal((await get(launcher.base, "/xgc2/view", {})).status, 403);
  assert.equal((await openStream(launcher.base, "/xgc2/view/events", { Origin: "http://evil.test" })).status, 403);
  // A same-origin read from an allowed page names no Origin, only its Referer.
  const referred = await get(launcher.base, "/xgc2/view", { "Sec-Fetch-Site": "same-origin", Referer: `${ORIGIN}/viewer/` });
  assert.equal(referred.status, 200);
  assert.equal((await get(launcher.base, "/xgc2/view", { "Sec-Fetch-Site": "cross-site", Referer: `${ORIGIN}/viewer/` })).status, 403);
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await fetch(`${launcher.base}/xgc2/view`, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : JSON.stringify({ view }) });
    assert.equal(response.status, 400, method);
  }
  for (const route of ["/xgc2/storage", "/xgc2/extensions/assets", "/xgc2/extensions/assets/archive"])
    for (const method of ["GET", "POST"])
      assert.equal((await fetch(`${launcher.base}${route}`, { method, headers: { Origin: ORIGIN } })).status, 404, `${method} ${route}`);
});

test("a restarted launcher starts with revision zero and no desired view", async (t) => {
  const first = await startLauncher(t);
  await first.launcher.waitForPort();
  const stated = await (await first.launcher.control()).call("PUT", "/v1/view", { body: { view } });
  assert.equal(stated.json.revision, "1");
  assert.deepEqual(await first.launcher.stop(), { code: 0, signal: null });
  assert.equal(fs.existsSync(first.socketPath), false);
  const second = await startLauncher(t, { runtimeDirectory: first.root });
  assert.equal(second.socketPath, first.socketPath);
  await second.launcher.waitForPort();
  const page = await get(second.launcher.base, "/xgc2/view");
  assert.deepEqual(page.json, { revision: "0", view: EMPTY_VIEW });
  const next = await (await second.launcher.control()).call("PUT", "/v1/view", { body: { view, expectedRevision: "0" } });
  assert.equal(next.json.revision, "1");
  assert.deepEqual(await second.launcher.stop(), { code: 0, signal: null });
});

test("SIGTERM ends the streams and drains; the socket goes with the process", async (t) => {
  const { launcher } = await startLauncher(t);
  await launcher.waitForPort();
  const stream = await openStream(launcher.base, "/xgc2/view/events");
  await stream.until((s) => s.frames.length === 1);
  const exit = await launcher.stop();
  assert.deepEqual(exit, { code: 0, signal: null }, launcher.errors);
  await stream.until((s) => s.closed);
  assert.equal(stream.frames.at(-1).event, "closing");
  assert.equal(fs.existsSync(launcher.socketPath), false);
});

test("the page gateway permits at most sixteen view streams", async (t) => {
  const { launcher } = await startLauncher(t);
  await launcher.waitForPort();
  const streams = [];
  t.after(() => { for (const stream of streams) stream.close(); });
  for (let i = 0; i < 16; i++) streams.push(await openStream(launcher.base, "/xgc2/view/events"));
  const overflow = await get(launcher.base, "/xgc2/view/events");
  assert.equal(overflow.status, 503);
  assert.equal(overflow.json.code, "resource_exhausted");
  assert.equal((await launcher.control()).described.facts.pages.view_streams, 16);
});

test("idle view streams receive heartbeat comments", async (t) => {
  const { createViewGateway } = require("../launcher/view-gateway.cjs");
  const gateway = createViewGateway(new ViewStore(), { heartbeatMs: 20 });
  const server = http.createServer((request, response) => gateway.events(request, response));
  t.after(async () => { gateway.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stream = await openStream(`http://127.0.0.1:${server.address().port}`, "/events");
  t.after(() => stream.close());
  await stream.until((s) => s.frames.length >= 2);
  assert.equal(stream.frames[0].event, "view");
  assert.equal(stream.frames[1].comment, true);
  assert.match(stream.text, /: hb/);
});

test("the launcher refuses a missing view input switch and invalid stdin", async (t) => {
  const missing = await startLauncher(t, { arguments: ({ socketPath }) => ["--control-socket", socketPath, "--port", "0"] });
  assert.equal((await missing.launcher.exited).code, 1);
  assert.match(missing.launcher.errors, /--view-input-stdin is required/);
  for (const stdin of ["", "[]", JSON.stringify({ layoutMode: "3d", runMode: "simulation", robots: [], visualizationTopics: [], startupInputPath: "retired" })]) {
    const { launcher } = await startLauncher(t, { stdin });
    assert.equal((await launcher.exited).code, 1);
    assert.match(launcher.errors, /cannot prepare web entrypoint/);
  }
});

test("the layout and desired-view gateway use the configured public URL prefix", async (t) => {
  const { launcher } = await startLauncher(t, {
    arguments: ({ socketPath }) => ["--control-socket", socketPath, "--view-input-stdin", "--host", "127.0.0.1", "--port", "0", "--public-url-prefix", "/viewer", "--frame-ancestors", "'self'", "--allowed-origin", ORIGIN],
  });
  await launcher.waitForPort();
  assert.equal((await get(launcher.base, "/viewer/layout.json")).json.layout.first, "3D!xgc2");
  assert.deepEqual((await get(launcher.base, "/viewer/xgc2/view")).json, { revision: "0", view: EMPTY_VIEW });
  const stream = await openStream(launcher.base, "/viewer/xgc2/view/events");
  t.after(() => stream.close());
  await stream.until((s) => s.frames.length === 1);
  assert.equal(stream.frames[0].id, "0");
  await (await launcher.control()).call("PUT", "/v1/view", { body: { view } });
  await stream.until((s) => s.frames.length === 2);
  assert.equal(stream.frames[1].id, "1");
  assert.equal((await fetch(`${launcher.base}/viewer/xgc2/storage`, { method: "POST", headers: { Origin: ORIGIN } })).status, 404);
});
