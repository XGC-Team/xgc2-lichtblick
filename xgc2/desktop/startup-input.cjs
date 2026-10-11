// SPDX-License-Identifier: MPL-2.0
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_INPUT_BYTES = 16384;
const MAX_TOKEN_BYTES = 1024;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const SUN_PATH_LIMIT = 108;

function invalid(message) { throw new TypeError(message); }
function object(value, name, allowed, required = allowed) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`unknown ${name} field ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`missing ${name} field ${key}`);
  return value;
}
function checkScope(value, name) {
  const scope = object(value, name, ["namespace", "user", "workspace"]);
  if (scope.namespace !== "lichtblick") invalid(`the ${name} belongs to the lichtblick namespace`);
  id(scope.user, `${name} user`);
  id(scope.workspace, `${name} workspace`);
  return scope;
}
function id(value, name) {
  if (typeof value !== "string" || !ID.test(value)) invalid(`${name} must be 1..128 canonical identifier characters`);
  return value;
}

/**
 * Reads one file the process owner granted. The path is walked without
 * following symbolic links, its parent must belong to this user with mode 0700
 * and the file must be a single-link regular file with mode 0600 and a bounded
 * size, so a replaced or foreign file is refused rather than read.
 */
function readPrivateFile(filePath, maximum) {
  if (process.platform !== "linux" || typeof filePath !== "string" || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) {
    invalid("a canonical absolute Linux path is required for a private input file");
  }
  const parts = filePath.split("/").filter(Boolean);
  const name = parts.pop();
  let directory;
  let file;
  try {
    directory = fs.openSync("/", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    for (const component of parts) {
      const next = fs.openSync(`/proc/self/fd/${directory}/${component}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(directory);
      directory = next;
    }
    const uid = process.geteuid();
    const parent = fs.fstatSync(directory);
    if (parent.uid !== uid || (parent.mode & 0o777) !== 0o700) invalid("the directory of a private input file must be owned by this user with mode 0700");
    file = fs.openSync(`/proc/self/fd/${directory}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) {
      invalid(`a private input file must be an owned single-link regular file with mode 0600 of at most ${maximum} bytes`);
    }
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    let read;
    while (count < bytes.length && (read = fs.readSync(file, bytes, count, bytes.length - count, count)) !== 0) count += read;
    if (count > maximum) invalid("a private input file exceeds its byte limit");
    return bytes.subarray(0, count);
  } finally {
    if (file != null) fs.closeSync(file);
    if (directory != null) fs.closeSync(directory);
  }
}

function checkUnixAddress(address, name) {
  if (typeof address !== "string" || !path.isAbsolute(address) || path.normalize(address) !== address || Buffer.byteLength(address) >= SUN_PATH_LIMIT) {
    invalid(`${name} must be a canonical absolute Unix socket path shorter than ${SUN_PATH_LIMIT} bytes`);
  }
  return address;
}

/**
 * The one private file a launcher or desktop owner is started with: where its
 * document storage is, which scope it may use, the credential for that storage
 * and the extension asset grant. The owner of the process writes it; nothing is
 * discovered from HOME, the working directory or the environment.
 */
function loadStartupInput(filePath) {
  let input;
  try {
    input = JSON.parse(readPrivateFile(filePath, MAX_INPUT_BYTES).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) invalid("the startup input is not valid JSON");
    throw error;
  }
  object(input, "startup input", ["schema_version", "operator_time_zone", "storage", "assets"]);
  if (input.schema_version !== 1) invalid("current startup input schema required");
  if (typeof input.operator_time_zone !== "string" || input.operator_time_zone.length < 1 || input.operator_time_zone.length > 128) invalid("authoritative operator time zone required");
  const storage = object(input.storage, "storage", ["reference", "scope", "view_scope", "token_file"], ["reference", "scope", "token_file"]);
  const reference = object(storage.reference, "storage reference", ["target_id", "service", "api_version", "instance_id", "profile", "endpoint"]);
  id(reference.target_id, "storage target_id");
  id(reference.instance_id, "storage instance_id");
  if (reference.service !== "xgc2.storage.v1.Storage" || reference.api_version !== "1" || reference.profile !== "http.v1") invalid("an instance-bound local storage-v1 reference is required");
  object(reference.endpoint, "storage endpoint", ["kind", "address"]);
  if (reference.endpoint.kind !== "unix") invalid("the storage endpoint must be a local Unix socket");
  checkUnixAddress(reference.endpoint.address, "storage endpoint address");
  const scope = checkScope(storage.scope, "storage scope");
  // The desired view lives in a scope of its own: its writes move that scope's revision, never the one the pages' saves are fenced by.
  const viewScope = storage.view_scope === undefined ? undefined : checkScope(storage.view_scope, "storage view_scope");
  if (viewScope && viewScope.user === scope.user && viewScope.workspace === scope.workspace) invalid("storage view_scope must differ from the storage scope");
  const token = readPrivateFile(storage.token_file, MAX_TOKEN_BYTES).toString("utf8");
  if (!TOKEN.test(token)) invalid("the storage credential must be one RFC 6750 bearer token without a trailing newline");
  const assets = object(input.assets, "assets", ["root", "access"]);
  if (typeof assets.root !== "string" || !path.isAbsolute(assets.root) || path.normalize(assets.root) !== assets.root) invalid("a canonical granted extension directory is required");
  if (assets.access !== "read-write" && assets.access !== "read-only") invalid("explicit extension asset access is required");
  return Object.freeze({
    operatorTimeZone: input.operator_time_zone,
    storage: Object.freeze({
      reference: Object.freeze({ ...reference, endpoint: Object.freeze({ ...reference.endpoint }) }),
      scope: Object.freeze({ ...scope }),
      ...(viewScope ? { viewScope: Object.freeze({ ...viewScope }) } : {}),
      authorization: Object.freeze({ Authorization: `Bearer ${token}` }),
    }),
    assets: Object.freeze({ root: assets.root, access: assets.access }),
  });
}

module.exports = { loadStartupInput, readPrivateFile, checkUnixAddress };
