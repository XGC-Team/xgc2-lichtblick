// SPDX-License-Identifier: MPL-2.0
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { timingSafeEqual } = require("node:crypto");
const { BootstrapBinding } = require("@xgc2/xrpc");

function createDomainFixture(reference, scope, assetRoot, storageToken) {
  const binding = new BootstrapBinding({ schema_version: 1, target_id: reference.target_id, service: "xgc2.lichtblick.v1.Lichtblick", api_version: "1", profile: "http.v1", endpoint: { kind: "https", address: "https://127.0.0.1:0" }, runtime_grant: "fixture-runtime", authentication: "mutual_tls", secret_handles: { tls_identity: "fixture-identity", tls_trust: "fixture-trust", authorization: "fixture-owner" }, storage_grants: ["fixture-documents", "fixture-assets"] });
  return { binding, resolveGrant(handle, purpose) {
    assertGrant(handle === "fixture-storage-auth" && purpose === "authorization");
    return { headers: { Authorization: `Bearer ${storageToken}` } };
  }, application: { schema_version: 1, operator_time_zone: "system", storage: { grant: "fixture-documents", reference, scope, authorization: "fixture-storage-auth" }, assets: { access: "read-write", grant: "fixture-assets", root: assetRoot } } };
}
function assertGrant(condition) { if (!condition) throw new Error("undeclared fixture grant"); }

// Explicit, isolated native credentials. No deployed grant resolver lives here.
function createTLSFixture(root) {
  const command = (args) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  command(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=sol8-test-ca", "-addext", "basicConstraints=critical,CA:TRUE"]);
  for (const role of ["server", "client"]) {
    command(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", `${role}.key`, "-out", `${role}.csr`, "-subj", `/CN=${role === "server" ? "localhost" : "sol8-owner"}`]);
    fs.writeFileSync(path.join(root, `${role}.ext`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${role === "server" ? "serverAuth" : "clientAuth"}\n${role === "server" ? "subjectAltName=DNS:localhost,IP:127.0.0.1\n" : ""}`);
    command(["x509", "-req", "-in", `${role}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${role}.pem`, "-days", "1", "-extfile", `${role}.ext`]);
  }
  for (const name of ["ca.pem", "server.pem", "server.key", "client.pem", "client.key"]) fs.chmodSync(path.join(root, name), 0o600);
  const read = (name) => fs.readFileSync(path.join(root, name));
  const clientTLS = { ca: read("ca.pem"), cert: read("client.pem"), key: read("client.key"), rejectUnauthorized: true, minVersion: "TLSv1.2" };
  const grant = "isolated-native-owner-grant-32-bytes";
  const binding = new BootstrapBinding({ schema_version: 1, target_id: "fixture", service: "xgc2.lichtblick.v1.Lichtblick", api_version: "1", profile: "http.v1", endpoint: { kind: "https", address: "https://127.0.0.1:0" }, runtime_grant: "fixture-runtime", authentication: "mutual_tls", secret_handles: { tls_identity: "fixture-identity", tls_trust: "fixture-trust", authorization: "fixture-owner" }, storage_grants: ["fixture-documents", "fixture-assets"] });
  const resolveGrant = (handle, kind) => {
    if (handle === "fixture-identity" && kind === "tls_identity") return { cert: read("server.pem"), key: read("server.key") };
    if (handle === "fixture-trust" && kind === "tls_trust") return { ca: read("ca.pem") };
    if (handle === "fixture-owner" && kind === "authorization") return { authorize(request) {
      const actual = Buffer.from(request.headers.authorization ?? ""); const expected = Buffer.from(`Bearer ${grant}`);
      return request.socket.getPeerCertificate().subject?.CN === "sol8-owner" && actual.length === expected.length && timingSafeEqual(actual, expected);
    } };
    throw new Error("undeclared fixture grant");
  };
  function writeInput(application, storageToken = "explicit-test-storage-owner-grant") {
    fs.writeFileSync(path.join(root, "rpc-token"), grant, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "storage-token"), storageToken, { mode: 0o600 });
    const input = path.join(root, "bootstrap.json");
    fs.writeFileSync(input, JSON.stringify({ schema_version: 1, binding, grants: {
      "fixture-identity": { kind: "tls_identity", cert_file: path.join(root, "server.pem"), key_file: path.join(root, "server.key") },
      "fixture-trust": { kind: "tls_trust", ca_file: path.join(root, "ca.pem") },
      "fixture-owner": { kind: "bearer", token_file: path.join(root, "rpc-token") },
      "fixture-storage-auth": { kind: "bearer", token_file: path.join(root, "storage-token") },
    }, ...(application ? { application: { operator_time_zone: "system", ...application } } : {}) }), { mode: 0o600 });
    return input;
  }
  return { binding, resolveGrant, clientTLS, grant, writeInput };
}
module.exports = { createTLSFixture, createDomainFixture };
