// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only stand-in for the document storage service: the storage-v1 subset the
// managed client uses (snapshot of explicit keys or one family, CAS batch, receipt)
// behind a real instance-fenced XRPC Unix host. The real provider is exercised by
// the native tests; this one lets every other test run without it.
const { createRPCHost, newInstanceId } = require("@xgc2/xrpc");

function createFakeStorage({ socketPath, scope, token = "explicit-test-storage-owner-grant", targetId = "fixture" }) {
  const instanceId = newInstanceId();
  const databaseId = "fake-database";
  const schema = "lichtblick.persistence.v1";
  const documents = new Map(); // key -> { version, data, deleted }
  const receipts = new Map();
  let revision = 0n;
  const state = { calls: [], failNextBatch: undefined, beforeBatch: undefined, failSnapshots: 0 };
  const current = () => ({ database_id: databaseId, schema, revision: String(revision) });
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
    if (JSON.stringify(body.scope) !== JSON.stringify(scope)) return fail(response, 403, "permission_denied", "scope rejected");
    state.calls.push({ route: request.url, body, requestId: context.requestId });
    if (request.url === "/v1/snapshot") {
      if (state.failSnapshots > 0) { state.failSnapshots -= 1; return fail(response, 503, "unavailable", "injected failure"); }
      const query = body.queries[0];
      if (body.at && body.at.revision !== String(revision)) return fail(response, 409, "conflict", "snapshot revision is gone");
      let keys = query.keys;
      if (!keys) keys = [...documents.keys()].filter((key) => documents.get(key).data?.family === query.equal[0]).sort();
      const records = keys.map((key) => {
        const document = documents.get(key);
        if (!document) return { key, version: "0", missing: true };
        if (document.deleted) return { key, version: String(document.version), deleted: true };
        return { key, version: String(document.version), data: document.data };
      });
      return reply(response, 200, { token: current(), results: [{ collection: "documents", records }] });
    }
    if (request.url === "/v1/batch") {
      if (state.beforeBatch) await state.beforeBatch(body);
      if (state.failNextBatch) {
        const failure = state.failNextBatch; state.failNextBatch = undefined;
        if (failure.commit) apply(body);
        return failure.destroy ? response.destroy() : fail(response, failure.status ?? 503, failure.code ?? "unavailable", "injected failure");
      }
      if (body.expected.database_id !== databaseId || body.expected.schema !== schema || body.expected.revision !== String(revision)) return fail(response, 409, "conflict", "database revision conflict");
      for (const mutation of body.mutations) {
        const document = documents.get(mutation.key);
        if (String(document?.version ?? 0) !== mutation.expected_version) return fail(response, 409, "conflict", `version conflict at ${mutation.key}`);
      }
      return reply(response, 200, apply(body));
    }
    if (request.url === "/v1/receipt") {
      const found = receipts.get(body.request_id);
      return found ? reply(response, 200, found) : fail(response, 404, "not_found", "no such receipt");
    }
    return fail(response, 404, "not_found", "unknown route");
  }, { instanceId, unixPath: socketPath, maxBodyBytes: 8 * 1024 * 1024 });
  function apply(body) {
    revision += 1n;
    const versions = body.mutations.map((mutation) => {
      if (mutation.delete) documents.set(mutation.key, { version: revision, deleted: true });
      else documents.set(mutation.key, { version: revision, data: mutation.data });
      return { collection: "documents", key: mutation.key, version: String(revision) };
    });
    const receipt = { token: current(), request_id: body.request_id, durability: "sqlite-full", versions };
    receipts.set(body.request_id, receipt);
    return receipt;
  }
  return {
    instanceId, state, token, scope, socketPath,
    reference: { target_id: targetId, service: "xgc2.storage.v1.Storage", api_version: "1", instance_id: instanceId, profile: "http.v1", endpoint: { kind: "unix", address: socketPath } },
    get revision() { return revision; },
    document: (family, key) => documents.get(`${family}:${key}`),
    /** Changes another document, as a page would, so database tokens move. */
    touch(family, key, value) { apply({ request_id: `touch-${revision}`, mutations: [{ key: `${family}:${key}`, data: { family, key, value } }] }); },
    start: () => host.listen(),
    close: () => host.close(),
  };
}

module.exports = { createFakeStorage };
