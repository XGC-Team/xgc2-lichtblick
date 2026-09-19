// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
// Run: yarn node --test web/offline-tests/http-assets.browser.cjs
// Existing Chrome only; no station or HTTP server is started.
const { chromium } = require("@playwright/test");
const esbuild = require("esbuild");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { test } = require("node:test");

const origin = "http://192.0.2.10:5174";
const payload = Buffer.from("frozen snapshot: exact camera sample\n");
const expected = createHash("sha256").update(payload).digest("hex");

async function withPage(t) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addCookies([
    { name: "snapshot_session_test", value: "existing-session", url: origin, httpOnly: true },
  ]);
  const page = await context.newPage();
  const requests = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/") {
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      return;
    }
    const cookie = (await request.allHeaders()).cookie;
    requests.push({ origin: url.origin, path: url.pathname, cookie });
    if (!cookie?.includes("snapshot_session_test=existing-session")) {
      await route.fulfill({ status: 401, body: "session required" });
    } else if (url.pathname === "/redirect") {
      await route.fulfill({ status: 302, headers: { location: origin + "/redirect-target" } });
    } else {
      await route.fulfill({
        contentType: "application/octet-stream",
        body: url.pathname === "/tampered" ? Buffer.from("changed bytes") : payload,
      });
    }
  });
  await page.goto(origin);
  const source = path.resolve(__dirname, "../src/offline/state.ts");
  const bundle = await esbuild.build({
    stdin: {
      contents: `import * as state from ${JSON.stringify(source)}; globalThis.offlineState = state;`,
      resolveDir: path.resolve(__dirname, "../.."),
    },
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  assert.deepEqual(
    await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle })),
    { secure: false, subtle: "undefined" },
  );
  return { page, requests };
}

test("desktop HTTP LAN computes exact SHA-256 without crypto.subtle", async (t) => {
  const { page } = await withPage(t);
  // Independent Node/OpenSSL oracle, including empty, block boundary and binary input.
  const vectors = [
    Buffer.alloc(0),
    Buffer.from("abc"),
    Buffer.alloc(64, 0xa5),
    Buffer.alloc(65537, 0xff),
  ];
  for (const input of vectors) {
    const actual = await page.evaluate(
      (bytes) => globalThis.offlineState.digest(Uint8Array.from(bytes).buffer),
      Array.from(input),
    );
    assert.equal(actual, createHash("sha256").update(input).digest("hex"));
  }
});

test("desktop HTTP LAN verifies authenticated same-origin assets and rejects tampering and escape", async (t) => {
  const { page, requests } = await withPage(t);
  const result = await page.evaluate(
    async ({ expected, size }) => {
      const { verifiedFetch } = globalThis.offlineState;
      const fetchAsset = (path, maximum = size) =>
        verifiedFetch(new URL(path, location.origin), expected, maximum);
      const errors = {};
      const valid = new TextDecoder().decode(await fetchAsset("/valid"));
      for (const [name, path, limit] of [
        ["tamper", "/tampered", size],
        ["overflow", "/too-large", 1],
        ["redirect", "/redirect", size],
        ["crossOrigin", "http://192.0.2.11:5174/denied", size],
        ["credentialsInURL", "http://user:password@192.0.2.10:5174/denied", size],
      ]) {
        try {
          await fetchAsset(path, limit);
          errors[name] = "unexpected success";
        } catch (error) {
          errors[name] = error.message;
        }
      }
      return { valid, errors, visibleCookie: document.cookie };
    },
    { expected, size: payload.length },
  );
  assert.equal(result.valid, payload.toString());
  assert.equal(result.visibleCookie, "", "the browser must carry an existing HttpOnly cookie");
  assert.match(result.errors.tamper, /hash mismatch/);
  assert.match(result.errors.overflow, /byte limit/);
  assert.notEqual(result.errors.redirect, "unexpected success");
  assert.match(result.errors.crossOrigin, /Cross-origin/);
  assert.match(result.errors.credentialsInURL, /Cross-origin/);
  assert.deepEqual(
    requests.map((r) => r.path),
    ["/valid", "/tampered", "/too-large", "/redirect"],
  );
  assert.ok(
    requests.every(
      (r) => r.origin === origin && r.cookie === "snapshot_session_test=existing-session",
    ),
  );
  console.log(
    JSON.stringify({
      origin,
      secure: false,
      exactHashVerified: true,
      tamperRejected: true,
      httpOnlyCookieSent: true,
      redirectBlockedBeforeFollow: true,
    }),
  );
});
