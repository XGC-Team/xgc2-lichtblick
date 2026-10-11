// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only stand-in for the document storage service: the storage-v1 subset the
// managed client uses (snapshot of explicit keys or one family, CAS batch, receipt)
// behind a real instance-fenced XRPC Unix host. The real provider is exercised by
// the native tests; this one lets every other test run without it.
const { createRPCHost, newInstanceId } = require("@xgc2/xrpc");

// Like the real provider, one database holds several scopes and every scope has its own
// revision: a write in one scope never moves the token another scope is fenced by.
function createFakeStorage({ socketPath, scope, viewScope, token = "explicit-test-storage-owner-grant", targetId = "fixture" }) {
  const instanceId = newInstanceId();
  const databaseId = "fake-database";
  const schema = "lichtblick.persistence.v1";
  const scopes = new Map([[JSON.stringify(scope), { name: "page", documents: new Map(), receipts: new Map(), revision: 0n }]]);
  if (viewScope) scopes.set(JSON.stringify(viewScope), { name: "view", documents: new Map(), receipts: new Map(), revision: 0n });
  const named = (name) => [...scopes.values()].find((entry) => entry.name === name);
  const state = { calls: [], failNextBatch: undefined, beforeBatch: undefined, failSnapshots: 0 };
  const current = (entry) => ({ database_id: databaseId, schema, revision: String(entry.revision) });
  const reply = (response, status, value) => {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
    response.end(body);
  };
  const fail = (response, status, code, message) => reply(response, status, { error: { code, message } });
  const host = createRPCHost(async (request, response, context) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.headers.authorization !== `Bearer ${token}`) return fail(response, 403, "permission_denied", "storage credential rejected");
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const entry = scopes.get(JSON.stringify(body.scope));
    if (!entry) return fail(response, 403, "permission_denied", "scope rejected");
    state.calls.push({ route: request.url, body, requestId: context.requestId, scope: entry.name });
    const { documents, receipts } = entry;
    if (request.url === "/v1/snapshot") {
      if (state.failSnapshots > 0) { state.failSnapshots -= 1; return fail(response, 503, "unavailable", "injected failure"); }
      const query = body.queries[0];
      if (body.at && body.at.revision !== String(entry.revision)) return fail(response, 409, "conflict", "snapshot revision is gone");
      let keys = query.keys;
      if (!keys) keys = [...documents.keys()].filter((key) => documents.get(key).data?.family === query.equal[0]).sort();
      const records = keys.map((key) => {
        const document = documents.get(key);
        if (!document) return { key, version: "0", missing: true };
        if (document.deleted) return { key, version: String(document.version), deleted: true };
        return { key, version: String(document.version), data: document.data };
      });
      return reply(response, 200, { token: current(entry), results: [{ collection: "documents", records }] });
    }
    if (request.url === "/v1/batch") {
      if (state.beforeBatch) await state.beforeBatch(body);
      if (state.failNextBatch) {
        const failure = state.failNextBatch; state.failNextBatch = undefined;
        if (failure.commit) apply(entry, body);
        return failure.destroy ? response.destroy() : fail(response, failure.status ?? 503, failure.code ?? "unavailable", "injected failure");
      }
      if (body.expected.database_id !== databaseId || body.expected.schema !== schema || body.expected.revision !== String(entry.revision)) return fail(response, 409, "conflict", "database revision conflict");
      for (const mutation of body.mutations) {
        const document = documents.get(mutation.key);
        if (String(document?.version ?? 0) !== mutation.expected_version) return fail(response, 409, "conflict", `version conflict at ${mutation.key}`);
      }
      return reply(response, 200, apply(entry, body));
    }
    if (request.url === "/v1/receipt") {
      const found = receipts.get(body.request_id);
      return found ? reply(response, 200, found) : fail(response, 404, "not_found", "no such receipt");
    }
    return fail(response, 404, "not_found", "unknown route");
  }, { instanceId, unixPath: socketPath, maxBodyBytes: 8 * 1024 * 1024 });
  function apply(entry, body) {
    entry.revision += 1n;
    const versions = body.mutations.map((mutation) => {
      if (mutation.delete) entry.documents.set(mutation.key, { version: entry.revision, deleted: true });
      else entry.documents.set(mutation.key, { version: entry.revision, data: mutation.data });
      return { collection: "documents", key: mutation.key, version: String(entry.revision) };
    });
    const receipt = { token: current(entry), request_id: body.request_id, durability: "sqlite-full", versions };
    entry.receipts.set(body.request_id, receipt);
    return receipt;
  }
  // The scope a family lives in: the desired view has its own, everything else is a page's document.
  const scopeOf = (family) => named(family === "view" ? "view" : "page");
  return {
    instanceId, state, token, scope, viewScope, socketPath,
    reference: { target_id: targetId, service: "xgc2.storage.v1.Storage", api_version: "1", instance_id: instanceId, profile: "http.v1", endpoint: { kind: "unix", address: socketPath } },
    /** The revision of the document scope, which the pages' saves are fenced by. */
    get revision() { return named("page").revision; },
    get viewRevision() { return named("view")?.revision; },
    document: (family, key) => scopeOf(family)?.documents.get(`${family}:${key}`),
    /** Changes another document, as a page would, so that scope's token moves. */
    touch(family, key, value) {
      const entry = scopeOf(family);
      apply(entry, { request_id: `touch-${entry.revision}`, mutations: [{ key: `${family}:${key}`, data: { family, key, value } }] });
    },
    start: () => host.listen(),
    close: () => host.close(),
  };
}

module.exports = { createFakeStorage };
