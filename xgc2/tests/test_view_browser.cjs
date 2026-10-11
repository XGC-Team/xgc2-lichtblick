// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright");
const { startLauncher } = require("./launcher_fixture.cjs");

const CHANNEL = "xgc2.lichtblick.embed";
const robotFrame = (robot) => `xgc/robots/${robot}/base_link`;

function layout(id, name, perspective) {
  const camera = { distance: 20, perspective, phi: 60, target: [0, 0, 0], targetOffset: [0, 0, 0], targetOrientation: [0, 0, 0, 1], thetaOffset: 45, fovy: 45, near: 0.5, far: 5000 };
  const data = { configById: { [`3D!${id}`]: { cameraState: camera } }, globalVariables: {}, userNodes: {}, playbackConfig: { speed: 1 }, layout: `3D!${id}` };
  return { id, name, permission: "CREATOR_WRITE", baseline: { data, savedAt: new Date().toISOString() } };
}

/** The XGC page that embeds the viewer: it records every message the viewer posts to its parent. */
async function startHost() {
  const state = { viewerUrl: undefined, origin: undefined };
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
      window.__messages = [];
      window.addEventListener("message", (event) => window.__messages.push({ origin: event.origin, data: event.data }));
    </script><iframe id="viewer" style="width:1280px;height:800px;border:0" src="${state.viewerUrl}"></iframe></body>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return state;
}

test("an embedded page applies the view Core states, then leaves the operator in charge", { timeout: 150000 }, async (t) => {
  assert.ok(process.env.XGC2_LICHTBLICK_TEST_WEB_ROOT, "built native web application required");
  assert.ok(process.env.XGC2_BROWSER_TEST_BINARY, "explicit installed browser binary required");
  const host = await startHost();
  t.after(() => host.close());
  const { launcher, storage } = await startLauncher(t, {
    frameAncestors: `'self' ${host.origin}`,
    environment: { XGC2_LICHTBLICK_WEB_STATIC_ROOT: process.env.XGC2_LICHTBLICK_TEST_WEB_ROOT },
  });
  await launcher.waitForPort();
  const control = await launcher.control();
  host.viewerUrl = `${launcher.base}/?xgc2Embed=1&xgc2ParentOrigin=${encodeURIComponent(host.origin)}`;

  const key = (id) => JSON.stringify(["local", id]);
  storage.touch("layouts", key("first"), layout("first", "First", true));
  storage.touch("layouts", key("second"), layout("second", "Second", true));
  storage.touch("profile", "user", { currentLayoutId: "first", firstSeenTime: new Date().toISOString() });
  storage.touch("configuration", "language", "en");

  const browser = await chromium.launch({ executablePath: process.env.XGC2_BROWSER_TEST_BINARY, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"] });
  t.after(() => browser.close());
  const errors = [];
  const logs = [];
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (["warning", "error"].includes(message.type()) && !/WebSocket|Player alert/.test(message.text())) logs.push(message.text().slice(0, 300)); });
    await page.goto(host.origin);
    return { context, page, messages: () => page.evaluate(() => window.__messages) };
  };
  /** Waits until the viewer has posted a message that satisfies `predicate`; returns the newest such message. */
  const until = async (viewer, description, predicate, milliseconds = 30000) => {
    const deadline = Date.now() + milliseconds;
    for (;;) {
      const found = (await viewer.messages()).map((entry) => entry.data).filter(predicate).at(-1);
      if (found) return found;
      assert.ok(Date.now() < deadline, `${description} (page errors: ${errors.join("; ")}; console: ${JSON.stringify(logs.slice(-12))}; messages: ${JSON.stringify((await viewer.messages()).slice(-6))})`);
      await delay(100);
    }
  };
  const panelState = (panelId, extra = () => true) => (message) => message?.type === "navigation-state" && message.panelId === panelId && message.available && extra(message);
  const command = (viewer, panelId, action) => viewer.page.evaluate(({ panelId, action, origin }) => {
    document.getElementById("viewer").contentWindow.postMessage({ channel: "xgc2.lichtblick.embed", version: 2, sender: "xgc2", type: "navigation", panelId, action }, origin);
  }, { panelId, action, origin: launcher.base });
  const state = async (view, expectedRevision) => {
    const response = await control.call("PUT", "/v1/view", { body: expectedRevision === undefined ? { view } : { view, expectedRevision } });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return response.json;
  };

  // The embedded viewer shows the layout its profile selected and announces its capabilities.
  const viewer = await open();
  t.after(() => viewer.context.close());
  const ready = await until(viewer, "the embed bridge did not announce itself", (message) => message?.channel === CHANNEL && message.type === "ready");
  assert.ok(ready.capabilities.includes("layouts"));
  assert.ok(!ready.visibleSurfaces.includes("layouts"));
  await until(viewer, "the first layout's 3D panel never became navigable", panelState("3D!first", (message) => message.perspective === true));

  // Core states a view: the page selects the layout, opens the sidebar and steers the camera of the new panel.
  const first = await state({ layoutId: "second", followRobot: "uav1", perspective: false, visibleSurfaces: ["layouts"] });
  assert.equal(first.unchanged, false);
  await until(viewer, "the page did not apply the stated view", panelState("3D!second", (message) => message.perspective === false && message.followFrameId === robotFrame("uav1")));
  await until(viewer, "the page did not show the stated surface", (message) => message?.type === "ready" && message.visibleSurfaces.includes("layouts"));
  // The selected layout is persisted by the page like any operator choice.
  const profile = async () => storage.document("profile", "user")?.data?.value;
  for (let attempt = 0; attempt < 100 && (await profile())?.currentLayoutId !== "second"; attempt++) await delay(100);
  assert.equal((await profile()).currentLayoutId, "second");

  // The operator takes over: a manual change is not reverted, however long the page runs.
  await command(viewer, "3D!second", "perspective");
  await until(viewer, "the operator's projection change did not reach the panel", panelState("3D!second", (message) => message.perspective === true));
  await delay(2000);
  const afterManual = (await viewer.messages()).map((entry) => entry.data).filter(panelState("3D!second")).at(-1);
  assert.equal(afterManual.perspective, true, "the page fought the operator");
  assert.equal(afterManual.followFrameId, robotFrame("uav1"));

  // A new revision states its fields again, and only those.
  const second = await state({ perspective: false });
  assert.notEqual(second.revision, first.revision);
  await until(viewer, "a new revision was not applied", panelState("3D!second", (message) => message.perspective === false && message.followFrameId === robotFrame("uav1")));
  // The same statement again is no change and no event.
  assert.equal((await state({ perspective: false })).unchanged, true);

  // A page that opens later finds the stored view without anyone stating it again.
  await state({ layoutId: "second", followRobot: "ugv2", perspective: true, visibleSurfaces: [] });
  const later = await open();
  t.after(() => later.context.close());
  await until(later, "a later page did not find the stored view", panelState("3D!second", (message) => message.perspective === true && message.followFrameId === robotFrame("ugv2")));
  assert.deepEqual(errors, []);
});
