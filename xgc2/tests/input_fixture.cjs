// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only helpers for the private startup input and the sockets of one test.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TOKEN = "explicit-test-storage-owner-grant";

/** A fresh private directory (mode 0700), as a supervisor allocates for one process. */
function privateDirectory(prefix = "lichtblick-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
/** Writes the private startup input and the credential it names; returns the input's path. */
function writeStartupInput(root, { reference, scope, assets, token = DEFAULT_TOKEN, access = "read-write", timeZone = "system", change } = {}) {
  const tokenFile = path.join(root, "storage-token");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const input = { schema_version: 1, operator_time_zone: timeZone, storage: structuredClone({ reference, scope, token_file: tokenFile }), assets: { root: assets, access } };
  change?.(input);
  const file = path.join(root, "startup-input.json");
  fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  return file;
}
/** The startup input as the loader returns it, for tests that hand it over directly. */
function domainInput(reference, scope, assetRoot, token = DEFAULT_TOKEN, access = "read-write") {
  return {
    operatorTimeZone: "system",
    storage: { reference, scope, authorization: { Authorization: `Bearer ${token}` } },
    assets: { root: assetRoot, access },
  };
}

module.exports = { DEFAULT_TOKEN, privateDirectory, writeStartupInput, domainInput };
