// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

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

test("the definition is one process whose endpoint, high-level view input and ports are declared parameters", () => {
  assert.equal(document.apiVersion, "xgc.execution.process/v1");
  assert.deepEqual(Object.keys(document).sort(), ["apiVersion", "definitions"]);
  assert.equal(document.definitions.length, 1);
  const [definition] = document.definitions;
  assert.equal(definition.id, "lichtblick-web");
  assert.equal(definition.version, "3.0.0");
  for (const [fields, allowed] of [
    [
      definition,
      [
        "id",
        "version",
        "label",
        "description",
        "parameters",
        "setupFiles",
        "command",
        "services",
        "readiness",
        "stop",
        "logs",
      ],
    ],
    [definition.parameters, ["properties", "required", "groups"]],
    [definition.command, ["executable", "args", "workDir", "env", "stdinParameter"]],
    [definition.readiness, ["kind", "startGraceMs", "timeoutMs", "address", "masterUri"]],
    [definition.stop, ["graceMs", "rpc"]],
    [definition.logs, ["maxBytes", "files"]],
  ]) {
    for (const key of Object.keys(fields)) {
      assert.ok(allowed.includes(key), `unsupported field ${key}`);
    }
  }
  const { properties, required } = definition.parameters;
  assert.deepEqual(required.slice().sort(), ["socketPath", "viewInputJson"]);
  assert.deepEqual(Object.keys(properties).sort(), [
    "bridgePort",
    "frameAncestors",
    "port",
    "socketPath",
    "viewInputJson",
  ]);
  for (const [name, property] of Object.entries(properties)) {
    if (name !== "socketPath") {
      assert.equal(property["x-xgc-path-kind"], undefined, `path hint on ${name}`);
      assert.equal(property["x-xgc-file-extensions"], undefined, `file hint on ${name}`);
    }
    for (const key of Object.keys(property)) {
      assert.ok(
        [
          "type",
          "description",
          "default",
          "enum",
          "minimum",
          "maximum",
          "sensitive",
          "output",
          "fixedOnly",
          "x-xgc-path-kind",
          "x-xgc-file-extensions",
        ].includes(key),
        `unsupported parameter field ${key}`,
      );
    }
  }
  assert.deepEqual(properties.socketPath, {
    type: "string",
    description:
      "Absolute path of the control socket, inside a private runtime directory allocated by the process owner.",
    fixedOnly: true,
  });
  assert.equal(properties.viewInputJson.type, "string");
  assert.equal(Object.hasOwn(properties.viewInputJson, "default"), false);
  assert.deepEqual(properties.port, {
    type: "integer",
    description:
      "Lichtblick HTTP port on the local host; XGC uses the dedicated loopback port 18081",
    default: 18081,
    minimum: 1,
    maximum: 65535,
  });
  assert.deepEqual(properties.bridgePort, {
    type: "integer",
    description: "Foxglove-compatible WebSocket port on the local host",
    default: 8765,
    minimum: 1,
    maximum: 65535,
  });
  assert.deepEqual(properties.frameAncestors, {
    type: "string",
    description:
      "Optional CSP frame-ancestors source list. Empty preserves FRAME_ANCESTORS from the environment or the packaged launcher default, including the station's loopback-alias embedding policy.",
    default: "",
  });
  // The service is the one the launcher hosts, at the endpoint the process owner allocates.
  assert.deepEqual(definition.services, [
    {
      service: "xgc2.lichtblick.v1",
      api_version: "1",
      profile: "http.v1",
      endpointParameter: "socketPath",
    },
  ]);
  assert.equal(definition.readiness.kind, "describe");
  assert.ok(
    definition.readiness.startGraceMs > 0 &&
      definition.readiness.timeoutMs >= definition.readiness.startGraceMs,
  );
  assert.deepEqual(definition.stop, { graceMs: 20000 });
  // Product executables only: no wrapper, shell, probe command, or token and TLS parameters.
  assert.equal(definition.command.executable, "/usr/bin/xgc2-lichtblick-web");
  for (const retired of [
    "bootstrap",
    "token",
    "tls",
    "certificate",
    "storage-binary",
    "python",
    "bash",
    "sh",
  ]) {
    assert.ok(
      !JSON.stringify(definition).toLowerCase().includes(`"${retired}`) &&
        !definition.command.executable.includes(retired),
      retired,
    );
  }
  const used = new Set(
    [...definition.command.args, ...Object.values(definition.command.env ?? {})].flatMap(
      placeholders,
    ),
  );
  for (const name of used) {
    assert.ok(Object.hasOwn(properties, name), `${name} is not a declared parameter`);
  }
  assert.equal(definition.command.stdinParameter, "viewInputJson");
  assert.ok(definition.command.args.includes("--view-input-stdin"));
  for (const retired of ["--startup-input", "--layout-stdin", "${startupInputPath}"]) {
    assert.ok(!definition.command.args.includes(retired), retired);
  }
});

test("the launcher accepts the command the definition declares and answers the service it declares", async (t) => {
  const [definition] = document.definitions;
  const input = require("../launcher/testdata/frozen-layouts.json")[0].input;
  const { mapViewInput, prepareLayout } = require("../launcher/prepare-layout.cjs");
  const layout = prepareLayout(mapViewInput(input)).layout;
  const { launcher } = await startLauncher(t, {
    stdin: JSON.stringify(input),
    // What the packaged environment file supplies; the definition does not pass it.
    environment: { FRAME_ANCESTORS: "'self'" },
    arguments: ({ socketPath }) =>
      definition.command.args.map((argument) =>
        expand(argument, { socketPath, port: 0, bridgePort: 9, frameAncestors: "" }),
      ),
  });
  await launcher.waitForPort();
  const control = await launcher.control();
  const [service] = definition.services;
  assert.equal(control.described.service, service.service);
  assert.equal(control.described.api_version, service.api_version);
  assert.equal(control.described.ready, true);
  // The launcher built the layout from the high-level stdin document.
  const served = await fetch(`${launcher.base}/layout.json`);
  assert.equal(served.status, 200);
  assert.deepEqual(await served.json(), layout);
  assert.equal(
    served.headers.get("content-security-policy"),
    "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  );
});

test("the process frame policy overrides the environment in the actual HTTP response", async (t) => {
  const [definition] = document.definitions;
  const frameAncestors = "'self' https://operator.example:9443";
  const { launcher } = await startLauncher(t, {
    environment: { FRAME_ANCESTORS: "'self' https://unused-env.example" },
    arguments: ({ socketPath }) =>
      definition.command.args.map((argument) =>
        expand(argument, { socketPath, port: 0, bridgePort: 9, frameAncestors }),
      ),
  });
  await launcher.waitForPort();
  const response = await fetch(`${launcher.base}/`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-security-policy"),
    `frame-ancestors ${frameAncestors}; base-uri 'self'; object-src 'none'`,
  );
  assert.equal(response.headers.get("x-frame-options"), null);
});

test("an omitted process policy preserves the shipped loopback-alias embedding policy", async (t) => {
  const [definition] = document.definitions;
  const { launcher } = await startLauncher(t, {
    environment: {
      FRAME_ANCESTORS: undefined,
      XGC2_LICHTBLICK_WEB_ENV_FILE: path.resolve(__dirname, "../launcher/lichtblick-web.env"),
    },
    arguments: ({ socketPath }) =>
      definition.command.args.map((argument) =>
        expand(argument, {
          socketPath,
          port: 0,
          bridgePort: 9,
          frameAncestors: definition.parameters.properties.frameAncestors.default,
        }),
      ),
  });
  await launcher.waitForPort();
  const response = await fetch(`${launcher.base}/`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-security-policy"),
    "frame-ancestors 'self' http://127.0.0.1:5173 http://localhost:5173 " +
      "http://127.0.0.1:5174 http://localhost:5174 http://127.0.0.1:8787 " +
      "http://localhost:8787 http://127.0.0.1:8788 http://localhost:8788; " +
      "base-uri 'self'; object-src 'none'",
  );
});
