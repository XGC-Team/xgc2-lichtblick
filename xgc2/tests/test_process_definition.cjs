// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { startLauncher } = require("./launcher_fixture.cjs");

const FILE = path.resolve(__dirname, "../process-definitions/xgc2-lichtblick-web.json");
const document = JSON.parse(fs.readFileSync(FILE, "utf8"));

function placeholders(value) {
  return [...String(value).matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
}
function expand(value, values) {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    assert.ok(Object.hasOwn(values, name), `no value for ${name}`);
    return String(values[name]);
  });
}

test("the definition is one process whose endpoint, files and ports are declared parameters", () => {
  assert.equal(document.apiVersion, "xgc.execution.process/v1");
  assert.deepEqual(Object.keys(document).sort(), ["apiVersion", "definitions"]);
  assert.equal(document.definitions.length, 1);
  const [definition] = document.definitions;
  assert.equal(definition.id, "lichtblick-web");
  assert.equal(definition.version, "2.1.0");
  for (const [fields, allowed] of [
    [definition, ["id", "version", "label", "description", "parameters", "setupFiles", "command", "services", "readiness", "stop", "logs"]],
    [definition.parameters, ["properties", "required", "groups"]],
    [definition.command, ["executable", "args", "workDir", "env", "stdinParameter"]],
    [definition.readiness, ["kind", "startGraceMs", "timeoutMs", "address", "masterUri"]],
    [definition.stop, ["graceMs", "rpc"]],
    [definition.logs, ["maxBytes", "files"]],
  ]) {
    for (const key of Object.keys(fields)) assert.ok(allowed.includes(key), `unsupported field ${key}`);
  }
  const { properties, required } = definition.parameters;
  assert.deepEqual(required.slice().sort(), ["layoutJson", "socketPath", "startupInputPath"]);
  for (const property of Object.values(properties)) {
    for (const key of Object.keys(property)) assert.ok(["type", "description", "default", "enum", "minimum", "maximum", "sensitive", "output", "fixedOnly", "x-xgc-path-kind", "x-xgc-file-extensions"].includes(key), `unsupported parameter field ${key}`);
  }
  assert.deepEqual(properties.socketPath, { type: "string", description: "Absolute path of the control socket, inside a private runtime directory allocated by the process owner.", fixedOnly: true });
  assert.equal(properties.startupInputPath.fixedOnly, true);
  assert.equal(properties.startupInputPath["x-xgc-path-kind"], "file");
  assert.deepEqual(properties.startupInputPath["x-xgc-file-extensions"], [".json"]);
  assert.deepEqual(properties.port, { type: "integer", description: "Lichtblick HTTP port on the local host; XGC uses the dedicated loopback port 18081", default: 18081, minimum: 1, maximum: 65535 });
  assert.deepEqual(properties.bridgePort, { type: "integer", description: "Foxglove-compatible WebSocket port on the local host", default: 8765, minimum: 1, maximum: 65535 });
  // The service is the one the launcher hosts, at the endpoint the process owner allocates.
  assert.deepEqual(definition.services, [{ service: "xgc2.lichtblick.v1", api_version: "1", profile: "http.v1", endpointParameter: "socketPath" }]);
  assert.equal(definition.readiness.kind, "describe");
  assert.ok(definition.readiness.startGraceMs > 0 && definition.readiness.timeoutMs >= definition.readiness.startGraceMs);
  assert.deepEqual(definition.stop, { graceMs: 20000 });
  // Product executables only: no wrapper, shell, probe command, or token and TLS parameters.
  assert.equal(definition.command.executable, "/usr/bin/xgc2-lichtblick-web");
  for (const retired of ["bootstrap", "token", "tls", "certificate", "storage-binary", "python", "bash", "sh"]) {
    assert.ok(!JSON.stringify(definition).toLowerCase().includes(`"${retired}`) && !definition.command.executable.includes(retired), retired);
  }
  const used = new Set([...definition.command.args, ...Object.values(definition.command.env ?? {})].flatMap(placeholders));
  for (const name of used) assert.ok(Object.hasOwn(properties, name), `${name} is not a declared parameter`);
  assert.equal(definition.command.stdinParameter, "layoutJson");
});

test("the launcher accepts the command the definition declares and answers the service it declares", async (t) => {
  const [definition] = document.definitions;
  const layout = { configById: { scene: { title: "prepared" } }, layout: "scene" };
  const { launcher } = await startLauncher(t, {
    stdin: JSON.stringify(layout),
    // What the packaged environment file supplies; the definition does not pass it.
    environment: { FRAME_ANCESTORS: "'self'" },
    arguments: ({ input, socketPath }) => definition.command.args.map((argument) => expand(argument, { startupInputPath: input, socketPath, port: 0, bridgePort: 9 })),
  });
  await launcher.waitForPort();
  const control = await launcher.control();
  const [service] = definition.services;
  assert.equal(control.described.service, service.service);
  assert.equal(control.described.api_version, service.api_version);
  assert.equal(control.described.ready, true);
  // The prepared layout arrived on stdin, as the definition's stdin parameter delivers it.
  const served = await fetch(`${launcher.base}/layout.json`);
  assert.equal(served.status, 200);
  assert.deepEqual(await served.json(), layout);
});
