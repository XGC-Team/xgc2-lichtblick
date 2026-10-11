// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only: a managed client against the fake storage service, in a private directory.
const fs = require("node:fs");
const path = require("node:path");
const { createManagedDomainClientFromInput } = require("../launcher/managed-storage.cjs");
const { createFakeStorage } = require("./fake_storage.cjs");
const { domainInput, privateDirectory } = require("./input_fixture.cjs");

const scope = { namespace: "lichtblick", user: "alice", workspace: "lab" };
// The desired view lives in a scope of its own, so that stating it never moves the revision the pages' saves are fenced by.
const viewScope = { namespace: "lichtblick", user: "alice", workspace: "lab.view" };

/** The fake storage and, unless `client` is false, a managed client holding the asset grant. */
async function startStorage(t, { access = "read-write", client: withClient = true, withViewScope = true } = {}) {
  const root = privateDirectory("lichtblick-storage-");
  const assets = path.join(root, "assets");
  fs.mkdirSync(assets, { mode: 0o700 });
  const storage = createFakeStorage({ socketPath: path.join(root, "storage.sock"), scope, viewScope: withViewScope ? viewScope : undefined });
  await storage.start();
  const client = withClient ? createManagedDomainClientFromInput(domainInput(storage.reference, scope, assets, storage.token, access, withViewScope ? viewScope : undefined)) : undefined;
  t.after(async () => {
    await client?.close();
    await storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client?.ready;
  return { root, assets, storage, client, scope, viewScope: withViewScope ? viewScope : undefined };
}

module.exports = { scope, viewScope, startStorage };
