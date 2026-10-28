// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { startLauncher } = require("./launcher_fixture.cjs");

function request(base, resource, method, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request(new URL(resource, base), { method, headers }, (response) => {
      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(body) }));
      response.once("error", reject);
    });
    call.once("error", reject);
    call.end();
  });
}

test("HEAD returns real static metadata without opening a payload stream", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lichtblick-static-head-"));
  const streamLog = path.join(root, "opened-streams.txt");
  const preload = path.join(root, "count-streams.cjs");
  const { launcher } = await startLauncher(t, {
    runtimeDirectory: root,
    prepare({ web }) {
      fs.writeFileSync(streamLog, "");
      fs.writeFileSync(preload, `const fs=require('node:fs');const open=fs.createReadStream;fs.createReadStream=function(file,...args){fs.appendFileSync(${JSON.stringify(streamLog)},String(file)+'\\n');return open.call(this,file,...args);};`);
      const descriptor = fs.openSync(path.join(web, "bundle.1234567890abcdef.js"), "w");
      fs.ftruncateSync(descriptor, 8 << 20);
      fs.closeSync(descriptor);
      fs.writeFileSync(path.join(web, "small.txt"), "real file bytes");
    },
    // This process-local observer wraps the real fs function. GET below
    // proves that the probe records actual payload stream opens.
    environment: { NODE_OPTIONS: `--require ${preload}` },
  });
  t.after(async () => { launcher.child.kill("SIGTERM"); await launcher.exited; fs.rmSync(root, { recursive: true, force: true }); });
  await launcher.waitForPort();
  const head = await request(launcher.base, "/bundle.1234567890abcdef.js", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], String(8 << 20));
  assert.equal(head.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(head.body.length, 0);
  assert.equal(fs.readFileSync(streamLog, "utf8"), "");
  const unchanged = await request(launcher.base, "/bundle.1234567890abcdef.js", "HEAD", { "If-Modified-Since": head.headers["last-modified"] });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  const layout = await request(launcher.base, "/layout.json", "HEAD");
  assert.equal(layout.status, 200);
  assert.equal(layout.body.length, 0);
  assert.equal(fs.readFileSync(streamLog, "utf8"), "");
  const get = await request(launcher.base, "/small.txt", "GET");
  assert.equal(get.status, 200);
  assert.equal(get.body.toString(), "real file bytes");
  assert.match(fs.readFileSync(streamLog, "utf8"), /small\.txt\n$/);
});
