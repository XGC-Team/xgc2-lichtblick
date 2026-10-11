// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { isDeepStrictEqual } = require("node:util");
const { chromium } = require("playwright");
const { HTTPClient } = require("@xgc2/xrpc");
const { writeStartupInput } = require("./input_fixture.cjs");
const { rawCall } = require("./control_fixture.cjs");
const { createManagedDomainClient } = require("../launcher/managed-storage.cjs");


test("a real clean browser restores the camera saved by actual 3D interaction through the managed gateway", { timeout: 60000 }, async (t) => {
  assert.ok(process.env.XGC2_STORAGE_TEST_BINARY, "formal storage provider binary required");
  assert.ok(process.env.XGC2_LICHTBLICK_TEST_WEB_ROOT, "built native web application required");
  assert.ok(process.env.XGC2_BROWSER_TEST_BINARY, "explicit installed browser binary required");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s8-browser-"));
  const assets = path.join(root, "assets"); await fs.mkdir(assets, { mode: 0o700 });
  const scope = { namespace: "lichtblick", user: "browser", workspace: "test" };
  const viewScope = { ...scope, workspace: "test.view" };
  const ownerGrant = "explicit-browser-fixture-owner-grant";
  const grants = path.join(root, "grants.json"); await fs.writeFile(grants, JSON.stringify([{ ...scope, token: ownerGrant }, { ...viewScope, token: ownerGrant }]), { mode: 0o600 });
  const refs = path.join(root, "refs.json");
  const storage = spawn(process.env.XGC2_STORAGE_TEST_BINARY, ["--db", path.join(root, "storage.db"), "--manifest", path.resolve(__dirname, "../contracts/storage-manifest.json"), "--grants", grants, "--http-socket", path.join(root, "rpc.sock"), "--target-id", "fixture", "--ref-out", refs, "--create"], { stdio: "ignore" });
  let browser; let launcher; let product; let transport;
  async function stop(child) {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM");
    await Promise.race([exited, delay(3000, undefined, { ref: false }).then(() => { throw Error("native application did not drain"); })]);
    assert.equal(child.exitCode, 0);
  }
  t.after(async () => {
    await browser?.close(); await stop(launcher); await product?.close(); transport?.close(); await stop(storage);
    await fs.rm(root, { recursive: true, force: true });
  });
  let reference;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(storage.exitCode, null, "formal storage provider exited");
    try { [reference] = JSON.parse(await fs.readFile(refs, "utf8")); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(20);
  }
  assert.ok(reference, "storage did not become ready");
  transport = new HTTPClient({ localTarget: "fixture" });
  product = createManagedDomainClient({ scope, assetRoot: assets, call: async (route, body, options = {}) => {
    const response = await transport.call(reference, route, { timeoutMs: 3000, ...options, method: "POST", json: body, headers: { Authorization: `Bearer ${ownerGrant}` } });
    const value = JSON.parse(response.body); if (response.status !== 200) throw Error(JSON.stringify(value)); return value;
  } });
  await product.ready;
  const key = JSON.stringify(["local", "native-camera"]);
  const camera = { distance: 20, perspective: true, phi: 60, target: [0, 0, 0], targetOffset: [0, 0, 0], targetOrientation: [0, 0, 0, 1], thetaOffset: 45, fovy: 45, near: 0.5, far: 5000 };
  const data = { configById: { "3D!fixture": { cameraState: camera } }, globalVariables: {}, userNodes: {}, playbackConfig: { speed: 1 }, layout: "3D!fixture" };
  const snapshot = await product.request({ operation: "snapshot", keys: [{ family: "layouts", key }] });
  await product.request({ operation: "batch", expected: snapshot.token, requestId: "browser-seed", changes: [
    { family: "layouts", key, expectedVersion: "0", value: { id: "native-camera", name: "Managed Camera", permission: "CREATOR_WRITE", baseline: { data, savedAt: new Date().toISOString() } } },
    { family: "profile", key: "user", expectedVersion: "0", value: { currentLayoutId: "native-camera", firstSeenTime: new Date().toISOString() } },
    { family: "configuration", key: "language", expectedVersion: "0", value: "en" },
  ] });
  await product.close(); product = undefined; transport.close(); transport = undefined;
  const startupInput = writeStartupInput(root, { reference, scope, viewScope, assets, token: ownerGrant });
  const controlSocket = path.join(root, "control.sock");
  const buildInfo = path.join(root, "build-info.json"); await fs.writeFile(buildInfo, JSON.stringify({ schema: "xgc2.lichtblick-web.build.v1", package: "xgc2-lichtblick-web", version: "1.27.0-1~test", upstreamSha: "1".repeat(40) }));
  launcher = spawn(process.execPath, [path.resolve(__dirname, "../launcher/xgc2-lichtblick-web.js"), "--startup-input", startupInput, "--control-socket", controlSocket, "--host", "127.0.0.1", "--port", "0", "--control-plane-url", "ws://127.0.0.1:9"], { env: { ...process.env, XGC2_LICHTBLICK_WEB_STATIC_ROOT: process.env.XGC2_LICHTBLICK_TEST_WEB_ROOT, XGC2_LICHTBLICK_WEB_BUILD_INFO: buildInfo, XGC2_LICHTBLICK_WEB_ENV_FILE: path.join(root, "no-defaults") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errorsFromLauncher = ""; launcher.stderr.on("data", (chunk) => { errorsFromLauncher += chunk; });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`launcher readiness failed: ${errorsFromLauncher}`)), 5000);
    launcher.stdout.on("data", (chunk) => { output += chunk; const found = /serving Lichtblick web bundle on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(output); if (found) { clearTimeout(timer); resolve(found[1]); } });
    launcher.once("exit", () => { clearTimeout(timer); reject(Error(`launcher failed: ${errorsFromLauncher}`)); });
  });
  async function gateway(request) {
    const response = await fetch(`${origin}/xgc2/storage`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  }
  const describe = await rawCall(controlSocket, "GET", "/v1/describe", { timeoutMs: 1000 }); assert.equal(describe.status, 200); assert.equal(describe.json.ready, true);
  browser = await chromium.launch({ executablePath: process.env.XGC2_BROWSER_TEST_BINARY, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"] });
  let context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  let page = await context.newPage(); const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const networkErrors = [];
  page.on("response", (response) => { if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`); });
  await page.goto(origin);
  try { await page.locator("canvas").first().waitFor({ state: "visible", timeout: 20000 }); }
  catch { await page.screenshot({ path: "/tmp/sol8-browser-failure.png" }); throw Error(JSON.stringify({ ui: (await page.locator("body").innerText()).slice(0, 1500), errors, networkErrors, launcher: errorsFromLauncher.slice(0, 1000) })); }
  const canvas = page.locator("canvas").first(); const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 10 }); await page.mouse.up();
  let saved;
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await gateway({ operation: "snapshot", keys: [{ family: "layouts", key }] });
    saved = current.records[0].value?.working?.data.configById["3D!fixture"].cameraState;
    if (saved && !isDeepStrictEqual(saved, camera)) break;
    await delay(100);
  }
  assert.ok(saved, `actual camera movement did not reach storage; browser errors=${errors.join(";")}`); assert.notDeepEqual(saved, camera);
  await page.mouse.move(0, 0); await delay(300);
  await canvas.screenshot({ path: "/tmp/sol8-camera-first.png" });
  await context.clearCookies(); await page.evaluate(async () => { localStorage.clear(); sessionStorage.clear(); for (const database of await indexedDB.databases()) { if (database.name) indexedDB.deleteDatabase(database.name); } });
  await context.close();
  context = await browser.newContext({ viewport: { width: 1280, height: 850 } }); page = await context.newPage(); await page.goto(origin); await page.locator("canvas").first().waitFor({ state: "visible", timeout: 20000 });
  await delay(250);
  const restored = await gateway({ operation: "snapshot", keys: [{ family: "layouts", key }] });
  assert.deepEqual(restored.records[0].value.working.data.configById["3D!fixture"].cameraState, saved);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.locator("canvas").first().screenshot({ path: "/tmp/sol8-camera-restored.png" });
  await page.screenshot({ path: "/tmp/sol8-camera-ui.png" });
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByText("View", { exact: true }).click();
  const fieldInput = (label) => page.getByTestId("FieldEditor").filter({ has: page.getByText(label, { exact: true }) }).locator("xpath=following-sibling::*[1]").locator("input");
  const target = await fieldInput("Target").evaluateAll((inputs) => inputs.map((input) => Number(input.value)));
  assert.equal(target.length, 3);
  for (let index = 0; index < 3; index++) assert.ok(Math.abs(target[index] - saved.targetOffset[index]) <= 0.001, "cold browser camera controls must display the saved target");
  for (const [label, property] of [["Distance", "distance"], ["Theta", "thetaOffset"], ["Phi", "phi"]]) assert.ok(Math.abs(Number(await fieldInput(label).inputValue()) - saved[property]) <= 0.001, `cold browser must display saved ${property}`);
  assert.ok(saved.targetOffset.some((value) => value !== 0), "actual 3D pan must change camera target");
  await stop(launcher);
  await assert.rejects(rawCall(controlSocket, "GET", "/v1/describe", { timeoutMs: 500 }));
  await page.screenshot({ path: "/tmp/sol8-camera-settings.png" });
});
