// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { ORIGIN, startLauncher } = require("./launcher_fixture.cjs");
const { normalizeView } = require("../launcher/view-state.cjs");

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
  assert.equal(control.described.facts.storage, "ready");
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
  const { launcher, storage } = await startLauncher(t);
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
  // The document gateway refuses the view family altogether, but serves the others.
  const documents = (body) => fetch(`${launcher.base}/xgc2/storage`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  for (const body of [{ operation: "snapshot", keys: [{ family: "view", key: "desired" }] }, { operation: "snapshot", families: ["view"] },
    { operation: "batch", expected: { database_id: "x", schema: "x", revision: "0" }, requestId: "page-writes-view", changes: [{ family: "view", key: "desired", expectedVersion: "0", value: {} }] }]) {
    const response = await documents(body);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "permission_denied");
  }
  assert.equal(storage.document("view", "desired"), undefined);
  assert.equal((await documents({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] })).status, 200);
});

test("the desired view survives a launcher restart and a new page finds it", async (t) => {
  const first = await startLauncher(t);
  await first.launcher.waitForPort();
  const stated = await (await first.launcher.control()).call("PUT", "/v1/view", { body: { view } });
  assert.deepEqual(await first.launcher.stop(), { code: 0, signal: null });
  assert.equal(fs.existsSync(first.socketPath), false);
  // A second launcher over the same storage.
  const { spawn } = require("node:child_process");
  const { LAUNCHER } = require("./launcher_fixture.cjs");
  const child = spawn(process.execPath, [LAUNCHER, "--startup-input", first.input, "--control-socket", first.socketPath, "--host", "127.0.0.1", "--port", "0", "--allowed-origin", ORIGIN],
    { env: { ...process.env, XGC2_LICHTBLICK_WEB_STATIC_ROOT: first.web, XGC2_LICHTBLICK_WEB_BUILD_INFO: first.buildInfo, XGC2_LICHTBLICK_WEB_ENV_FILE: "/nonexistent.env", FRAME_ANCESTORS: "'self'" }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 8000;
  let port;
  while (!port && Date.now() < deadline) { port = /on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]; await delay(20); }
  assert.ok(port, output);
  const page = await get(`http://127.0.0.1:${port}`, "/xgc2/view");
  assert.deepEqual(page.json, { revision: stated.json.revision, view: normalizeView(view) });
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
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

test("a launcher without a view scope in its startup input does not start", async (t) => {
  const { launcher } = await startLauncher(t, { storage: { withViewScope: false } });
  const exit = await launcher.exited;
  assert.equal(exit.code, 1);
  assert.match(launcher.output + launcher.errors, /storage\.view_scope/);
});
