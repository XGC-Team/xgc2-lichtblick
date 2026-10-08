// SPDX-License-Identifier: MPL-2.0
"use strict";

const fs = require("node:fs/promises");
const constants = require("node:fs").constants;
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const FAMILY_LIMITS = Object.freeze({
  layouts: 2 * 1024 * 1024, profile: 65536, configuration: 65536,
  workspace: 65536, extensions: 256 * 1024, desktop: 65536,
});
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ASSET_WRITER_LOCK = ".asset-writer.lock";

class PersistenceError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
    this.outcome = "application_rejected";
  }
}
function invalid(message) { throw new PersistenceError("invalid_argument", message); }
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  return value;
}
function fields(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("undeclared request field");
}
function token(value) {
  object(value, "token"); fields(value, ["database_id", "schema", "revision"]);
  if (typeof value.database_id !== "string" || !ID.test(value.database_id) ||
      typeof value.schema !== "string" || !ID.test(value.schema) ||
      typeof value.revision !== "string" || !DECIMAL.test(value.revision)) invalid("invalid storage token");
  return value;
}
function identity(family, key) {
  if (!Object.hasOwn(FAMILY_LIMITS, family)) invalid("undeclared document family");
  if (typeof key !== "string" || key.length === 0 || Buffer.byteLength(key) > 480 || /[\x00-\x1f\x7f]/.test(key)) invalid("invalid document key");
  return `${family}:${key}`;
}
function decoded(key) {
  const separator = key.indexOf(":");
  const family = key.slice(0, separator);
  const original = key.slice(separator + 1);
  if (separator < 1 || identity(family, original) !== key) throw new PersistenceError("internal", "invalid stored document identity", 500);
  return { family, key: original };
}
function record(value) {
  const id = decoded(value.key);
  if (value.missing || value.deleted) return { ...id, version: value.version, missing: value.missing, deleted: value.deleted };
  object(value.data, "stored document");
  if (value.data.family !== id.family || value.data.key !== id.key) throw new PersistenceError("internal", "stored document identity mismatch", 500);
  return { ...id, version: value.version, value: value.data.value };
}

// The child inherits the parent's open file description. flock(2) ownership
// therefore remains with the parent's descriptor after this helper exits.
async function acquireAssetWriterLock(handle) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/flock", ["--nonblock", "--exclusive", "3"], {
      stdio: ["ignore", "ignore", "ignore", handle.fd], timeout: 5000, killSignal: "SIGKILL",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new PersistenceError(code === 1 ? "conflict" : "unavailable", code === 1 ? "extension asset grant already has a writer" : "extension asset lease acquisition failed", code === 1 ? 409 : 503));
    });
  });
}
function sameFile(first, second) { return first.dev === second.dev && first.ino === second.ino; }
function privateControlFile(stat) {
  return stat.isFile() && stat.nlink === 1n && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o7777n) === 0o600n;
}

// The injected call is the XRPC SDK client; domain code never opens a socket.
class ManagedDomainClient {
  constructor({ call, close = async () => {}, scope, assetRoot, timeZone = "system", assetAccess = "read-write" }) {
    object(scope, "scope"); fields(scope, ["namespace", "user", "workspace"]);
    if (scope.namespace !== "lichtblick" || typeof scope.user !== "string" || !ID.test(scope.user) || typeof scope.workspace !== "string" || !ID.test(scope.workspace)) invalid("explicit Lichtblick user/workspace scope required");
    if (typeof call !== "function") invalid("XRPC storage call required");
    if (typeof assetRoot !== "string" || !path.isAbsolute(assetRoot) || path.normalize(assetRoot) !== assetRoot) invalid("canonical granted extension directory required");
    if (process.platform !== "linux") invalid("extension asset grants require the Linux descriptor lease");
    if (assetAccess !== "read-write" && assetAccess !== "read-only") invalid("explicit extension asset access mode required");
    if (typeof timeZone !== "string" || !timeZone) invalid("operator time zone required");
    try { this.assetClock = new Intl.DateTimeFormat("sv-SE", { ...(timeZone === "system" ? {} : { timeZone }), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
    catch { invalid("valid operator IANA time zone or system required"); }
    this.call = call; this.scope = Object.freeze({ ...scope }); this.assetRoot = assetRoot;
    this.closeTransport = close; this.assetCount = 0; this.assetBytes = 0;
    this.pendingAssets = 0; this.pendingBytes = 0; this.maxAssets = 256; this.maxAssetBytes = 128 * 1024 * 1024;
    this.assetAccess = assetAccess; this.assetOperations = new Set(); this.assetClosing = false;
    this.ready = this.initializeAssets();
  }
  async initializeAssets() {
    try {
      if (await fs.realpath(this.assetRoot) !== this.assetRoot) invalid("extension grant must not traverse symbolic links");
      this.assetDirectory = await fs.open(this.assetRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      this.assetDirectoryIdentity = await this.assetDirectory.stat({ bigint: true });
      if (!this.assetDirectoryIdentity.isDirectory() || this.assetDirectoryIdentity.uid !== BigInt(process.getuid()) || (this.assetDirectoryIdentity.mode & 0o22n) !== 0n) invalid("extension grant must be an owned directory without group/other writes");
      this.assetAnchor = `/proc/self/fd/${this.assetDirectory.fd}`;
      if (this.assetAccess === "read-write") {
        this.assetWriter = await fs.open(path.join(this.assetAnchor, ASSET_WRITER_LOCK), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        this.assetWriterIdentity = await this.assetWriter.stat({ bigint: true });
        if (!privateControlFile(this.assetWriterIdentity)) invalid("extension asset control lock must be private, regular and owned");
        await acquireAssetWriterLock(this.assetWriter);
      }
      await this.assertAssetGrant();
      if (this.assetAccess === "read-only") return;
      const entries = await fs.readdir(this.assetAnchor, { withFileTypes: true });
      if (entries.length > this.maxAssets + 33) throw new PersistenceError("resource_exhausted", "extension asset directory exceeds quota", 429);
      for (const entry of entries) {
        if (entry.name === ASSET_WRITER_LOCK) continue;
        // Interrupted staging files remain charged until explicit maintenance.
        const stat = await fs.lstat(path.join(this.assetAnchor, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink()) invalid("extension grant contains an undeclared entry");
        this.assetCount++; this.assetBytes += stat.size;
      }
      if (this.assetCount > this.maxAssets || this.assetBytes > this.maxAssetBytes) throw new PersistenceError("resource_exhausted", "extension asset quota exceeded", 429);
      await this.assertAssetGrant();
    } catch (error) {
      await this.releaseAssetHandles();
      throw error;
    }
  }
  async assertAssetGrant() {
    if (!this.assetDirectory || await fs.realpath(this.assetRoot) !== this.assetRoot || !sameFile(this.assetDirectoryIdentity, await fs.lstat(this.assetRoot, { bigint: true }))) throw new PersistenceError("conflict", "extension asset grant directory was replaced", 409);
    if (this.assetWriter) {
      const current = await fs.lstat(path.join(this.assetAnchor, ASSET_WRITER_LOCK), { bigint: true });
      if (!privateControlFile(current) || !sameFile(this.assetWriterIdentity, current)) throw new PersistenceError("conflict", "extension asset control lock was replaced", 409);
    }
  }
  async domainOperation(operation, verifyAssets = false) {
    if (this.assetClosing) throw new PersistenceError("unavailable", "extension asset owner is closing", 503);
    const work = (async () => { await this.ready; if (verifyAssets) await this.assertAssetGrant(); return await operation(); })();
    this.assetOperations.add(work);
    try { return await work; } finally { this.assetOperations.delete(work); }
  }
  async assetOperation(operation) { return await this.domainOperation(operation, true); }
  beginDrain() { this.assetClosing = true; }
  async releaseAssetHandles() {
    const handles = [this.assetWriter, this.assetDirectory];
    this.assetWriter = undefined; this.assetDirectory = undefined;
    const results = await Promise.allSettled(handles.filter(Boolean).map((handle) => handle.close()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  async request(input, context = {}) {
    return await this.domainOperation(async () => {
    object(input, "request");
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_WIRE_BYTES) throw new PersistenceError("resource_exhausted", "document request too large", 413);
    if (input.operation === "snapshot") {
      fields(input, ["operation", "keys", "families", "after", "limit", "at"]);
      if ((input.keys !== undefined) === (input.families !== undefined)) invalid("choose explicit keys or one family");
      const query = { collection: "documents" };
      if (input.keys !== undefined) {
        if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 64) invalid("snapshot requires 1..64 keys");
        query.keys = input.keys.map((key) => { object(key, "key"); fields(key, ["family", "key"]); return identity(key.family, key.key); });
        if (new Set(query.keys).size !== query.keys.length) invalid("duplicate snapshot keys");
        if (input.after !== undefined || input.limit !== undefined) invalid("explicit keys do not accept pagination");
      } else {
        if (!Array.isArray(input.families) || input.families.length !== 1 || !Object.hasOwn(FAMILY_LIMITS, input.families[0])) invalid("one declared family per page required");
        query.index = "family"; query.equal = [input.families[0]];
        query.limit = input.limit ?? 128;
        if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 128) invalid("page limit must be 1..128");
        if (input.after !== undefined) { decoded(input.after); query.after = input.after; }
      }
      const result = await this.call("/v1/snapshot", { scope: this.scope, queries: [query], ...(input.at ? { at: token(input.at) } : {}) }, context);
      if (!Array.isArray(result.results) || result.results.length !== 1 || result.results[0].collection !== "documents") throw new PersistenceError("internal", "invalid storage snapshot", 502);
      return { token: token(result.token), records: result.results[0].records.map(record), ...(result.results[0].next_after ? { nextAfter: result.results[0].next_after } : {}) };
    }
    if (input.operation === "batch") {
      fields(input, ["operation", "expected", "requestId", "changes"]);
      if (typeof input.requestId !== "string" || !ID.test(input.requestId)) invalid("canonical request identity required");
      if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 256) invalid("batch requires 1..256 changes");
      const mutations = input.changes.map((change) => {
        object(change, "change"); fields(change, ["family", "key", "expectedVersion", "value", "delete"]);
        const key = identity(change.family, change.key);
        if (typeof change.expectedVersion !== "string" || !DECIMAL.test(change.expectedVersion)) invalid("canonical expected version required");
        if (change.delete !== undefined && change.delete !== true) invalid("delete must be true or omitted");
        if (change.delete && Object.hasOwn(change, "value")) invalid("deleted record cannot carry data");
        if (!change.delete && !Object.hasOwn(change, "value")) invalid("document value required");
        const data = change.delete ? undefined : { family: change.family, key: change.key, value: change.value };
        if (data && Buffer.byteLength(JSON.stringify(data)) > FAMILY_LIMITS[change.family]) throw new PersistenceError("resource_exhausted", "document family byte quota exceeded", 413);
        return { collection: "documents", key, expected_version: change.expectedVersion, ...(change.delete ? { delete: true } : { data }) };
      });
      if (new Set(mutations.map((m) => m.key)).size !== mutations.length) invalid("duplicate batch keys");
      const result = await this.call("/v1/batch", { scope: this.scope, expected: token(input.expected), request_id: input.requestId, mutations }, { ...context, requestId: input.requestId });
      try {
        return this.receipt(result, input.requestId, mutations);
      } catch (error) {
        // A reply received after submission cannot prove the write did not
        // commit. Keep its identity for read-only receipt reconciliation.
        error.outcome = "outcome_unknown"; error.requestId = input.requestId;
        throw error;
      }
    }
    if (input.operation === "receipt") {
      fields(input, ["operation", "requestId"]);
      if (typeof input.requestId !== "string" || !ID.test(input.requestId)) invalid("canonical request identity required");
      return this.receipt(await this.call("/v1/receipt", { scope: this.scope, request_id: input.requestId }, context), input.requestId);
    }
    invalid("undeclared persistence operation");
    });
  }
  receipt(result, requestId, mutations) {
    if (result.durability !== "sqlite-full" || typeof result.request_id !== "string" || !ID.test(result.request_id) || !Array.isArray(result.versions) || result.versions.some((v) => (v.collection !== undefined && v.collection !== "documents") || typeof v.version !== "string" || !DECIMAL.test(v.version))) throw new PersistenceError("internal", "storage did not return a durable receipt", 502);
    if (result.request_id !== requestId || new Set(result.versions.map((v) => v.key)).size !== result.versions.length || (mutations && (result.versions.length !== mutations.length || mutations.some((m) => !result.versions.some((v) => v.key === m.key))))) throw new PersistenceError("internal", "storage receipt identity mismatch", 502);
    return { token: token(result.token), requestId: result.request_id, durability: result.durability, versions: result.versions.map((version) => ({ ...decoded(version.key), version: version.version })) };
  }
  async publish(bytes, info) {
    if (this.assetAccess === "read-only") throw new PersistenceError("permission_denied", "extension asset grant is read-only", 403);
    return await this.assetOperation(async () => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_ASSET_BYTES) throw new PersistenceError("resource_exhausted", "archive must be 1..8 MiB", 413);
    object(info, "extension identity");
    if (typeof info.id !== "string" || typeof info.version !== "string" || !ASSET_ID.test(info.id) || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(info.version) || info.id.length + info.version.length > 96) invalid("canonical extension name/version required (96 bytes combined)");
    if (this.assetCount + this.pendingAssets >= this.maxAssets || this.assetBytes + this.pendingBytes + bytes.byteLength > this.maxAssetBytes) throw new PersistenceError("resource_exhausted", "extension quota exhausted; explicit maintenance required", 429);
    this.pendingAssets++; this.pendingBytes += bytes.byteLength;
    const temporary = path.join(this.assetAnchor, `.${randomUUID()}.pending`);
    let published;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const timestamp = this.assetClock.format(new Date()).replace(/[ :]/g, "-");
      for (let sequence = 1; sequence <= 256; sequence++) {
        const assetId = `${info.id}_${info.version.replace(/\+/g, "-")}_${timestamp}_${sequence}`;
        try { await fs.link(temporary, path.join(this.assetAnchor, `${assetId}.foxe`)); published = assetId; this.assetCount++; this.assetBytes += bytes.byteLength; break; }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      if (!published) throw new PersistenceError("resource_exhausted", "asset allocation exhausted", 429);
      await this.assetDirectory.sync();
      await this.assertAssetGrant();
      return { owner: "lichtblick", asset_id: published, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
    } finally {
      this.pendingAssets--; this.pendingBytes -= bytes.byteLength;
      await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await this.assetDirectory.sync();
    }
    });
  }
  async load(asset) {
    return await this.assetOperation(async () => {
    object(asset, "asset reference");
    if (asset.owner !== "lichtblick" || typeof asset.asset_id !== "string" || !ASSET_ID.test(asset.asset_id) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_ASSET_BYTES || typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)) invalid("invalid extension asset reference");
    const handle = await fs.open(path.join(this.assetAnchor, `${asset.asset_id}.foxe`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== asset.bytes) throw new PersistenceError("conflict", "extension asset size mismatch", 409);
      const content = await handle.readFile();
      if (createHash("sha256").update(content).digest("hex") !== asset.sha256) throw new PersistenceError("conflict", "extension asset digest mismatch", 409);
      await this.assertAssetGrant();
      return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    } finally { await handle.close(); }
    });
  }
  async close() {
    if (!this.assetClosePromise) {
      this.beginDrain();
      this.assetClosePromise = (async () => {
        await this.ready.catch(() => {});
        await Promise.allSettled([...this.assetOperations]);
        try { await this.closeTransport(); } finally { await this.releaseAssetHandles(); }
      })();
    }
    return await this.assetClosePromise;
  }
}

function createManagedDomainClient(options) { return new ManagedDomainClient(options); }

function createManagedPolicy(environment = process.env, diagnostics) {
  const { resolvePolicy } = require("@xgc2/xrpc");
  const budgets = { CALL_TIMEOUT_MS: 15000, SHUTDOWN_TIMEOUT_MS: 16000, HOST_MAX_CONNECTIONS: 32, HOST_MAX_IN_FLIGHT: 8, MAX_REQUEST_BYTES: MAX_ASSET_BYTES, MAX_RESPONSE_BYTES: 64 * 1024 * 1024, CLIENT_MAX_CONNECTIONS: 8, CLIENT_MAX_REFERENCES: 1 };
  return resolvePolicy({ environment, diagnostics, defaults: budgets, ceilings: budgets });
}

function createManagedDomainClientFromBootstrap({ binding, resolveGrant, application }, policy) {
  const { BootstrapBinding, HTTPClient } = require("@xgc2/xrpc");
  if (!(binding instanceof BootstrapBinding) || typeof resolveGrant !== "function") invalid("explicit SDK bootstrap owner required");
  object(application, "Lichtblick application startup"); fields(application, ["schema_version", "storage", "assets", "operator_time_zone"]);
  if (application.schema_version !== 1) invalid("current Lichtblick application startup schema required");
  if (typeof application.operator_time_zone !== "string" || !application.operator_time_zone) invalid("authoritative operator time zone required");
  const storage = object(application.storage, "storage grant"); fields(storage, ["grant", "reference", "scope", "authorization"]);
  const assets = object(application.assets, "asset grant"); fields(assets, ["grant", "root", "access"]);
  if (!["read-only", "read-write"].includes(assets.access)) invalid("explicit asset read-only/read-write grant required");
  if (storage.grant === assets.grant || !binding.storage_grants.includes(storage.grant) || !binding.storage_grants.includes(assets.grant)) invalid("explicit distinct document and asset grants required");
  const reference = object(storage.reference, "storage reference");
  fields(reference, ["target_id", "service", "api_version", "instance_id", "profile", "endpoint"]);
  if (reference.service !== "xgc2.storage.v1.Storage" || reference.api_version !== "1" || !ID.test(reference.instance_id ?? "") || reference.profile !== "http.v1" || reference.endpoint?.kind !== "unix" || reference.target_id !== binding.target_id) invalid("instance-bound local storage-v1 reference required");
  const authorization = resolveGrant(storage.authorization, "authorization");
  if (!authorization?.headers || typeof authorization.headers !== "object") invalid("outbound storage authorization grant required");
  if (!policy || typeof policy.effective !== "function") invalid("composition-owned resolved runtime policy required");
  const transport = new HTTPClient({ policy, localTarget: binding.target_id });
  const call = async (route, body, options = {}) => {
    let response;
    try {
      response = await transport.call(reference, route, { timeoutMs: Math.min(options.timeoutMs ?? policy.fields.CALL_TIMEOUT_MS.value, policy.fields.CALL_TIMEOUT_MS.value), signal: options.signal, requestId: options.requestId, method: "POST", json: body, headers: authorization.headers });
    } catch (error) {
      const failure = new PersistenceError(error.code ?? "unavailable", "storage transport failed", 503);
      failure.outcome = error.disposition ?? "outcome_unknown"; failure.requestId = options.requestId;
      throw failure;
    }
    let value;
    try { value = JSON.parse(response.body.toString("utf8")); }
    catch {
      const failure = new PersistenceError("internal", "storage returned invalid JSON", 502);
      if (route === "/v1/batch") { failure.outcome = "outcome_unknown"; failure.requestId = options.requestId; }
      throw failure;
    }
    if (response.status < 200 || response.status >= 300) {
      const failure = value.error ?? value;
      throw new PersistenceError(failure.code ?? "internal", failure.message ?? "storage request failed", response.status);
    }
    return value;
  };
  try {
    return createManagedDomainClient({ scope: storage.scope, assetRoot: assets.root, assetAccess: assets.access, timeZone: application.operator_time_zone, call, close: () => transport.close() });
  } catch (error) {
    void transport.close();
    throw error;
  }
}

module.exports = { MAX_WIRE_BYTES, MAX_ASSET_BYTES, PersistenceError, createManagedPolicy, createManagedDomainClient, createManagedDomainClientFromBootstrap };
