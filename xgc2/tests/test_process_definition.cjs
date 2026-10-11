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

test("the definition is one host process whose endpoint, files and port are declared parameters", () => {
  assert.equal(document.apiVersion, "xgc.execution.process/v1");
  assert.equal(document.definitions.length, 1);
  const [definition] = document.definitions;
  assert.equal(definition.id, "lichtblick-web");
  assert.deepEqual(definition.drivers, ["host"]);
  const { properties, required, additionalProperties } = definition.parameters;
  assert.equal(additionalProperties, false);
  assert.deepEqual(required.slice().sort(), ["layoutJson", "socketPath", "startupInputPath"]);
  const owned = Object.entries(properties).filter(([, property]) => property.ownedEndpoint);
  assert.deepEqual(owned.map(([name, property]) => [name, property.ownedEndpoint, property.fixedOnly]), [["socketPath", "unix-socket", true]]);
  assert.equal(properties.startupInputPath["x-xgc-path-kind"], "file");
  assert.equal(properties.startupInputPath.fixedOnly, true);
  // The service is the one the launcher hosts, at the endpoint the process owner allocates.
  assert.deepEqual(definition.services, [{ service: "xgc2.lichtblick.v1", api_version: "1", profile: "http.v1", endpointParameter: "socketPath", describePath: "/v1/describe" }]);
  assert.equal(definition.readiness.kind, "describe");
  assert.ok(definition.readiness.startGraceMs > 0 && definition.readiness.timeoutMs >= definition.readiness.startGraceMs);
  assert.equal(definition.restart.mode, "never");
  // Product executables only: no wrapper, shell, probe command, or token and TLS parameters.
  assert.equal(definition.command.executable, "/usr/bin/xgc2-lichtblick-web");
  assert.equal(definition.command.directExecutable, true);
  for (const retired of ["bootstrap", "token", "tls", "certificate", "storage-binary", "python", "bash", "sh"]) {
    assert.ok(!JSON.stringify(definition).toLowerCase().includes(`"${retired}`) && !definition.command.executable.includes(retired), retired);
  }
  const used = new Set([...definition.command.args, ...Object.values(definition.command.env ?? {})].flatMap(placeholders));
  for (const name of used) assert.ok(Object.hasOwn(properties, name), `${name} is not a declared parameter`);
  assert.equal(definition.command.stdinParameter, "layoutJson");
  for (const claim of definition.resourceClaims) assert.ok(Object.hasOwn(properties, claim.portParameter));
  assert.ok(Object.keys(definition).every((key) => key !== "exec"));
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
