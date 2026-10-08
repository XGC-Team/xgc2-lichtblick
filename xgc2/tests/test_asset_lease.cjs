// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { createManagedDomainClient } = require("../launcher/managed-storage.cjs");

const LOCK = ".asset-writer.lock";
const scope = { namespace: "lichtblick", user: "asset-test", workspace: "lease" };
const options = (root, assetAccess = "read-write") => ({
  scope, assetRoot: root, assetAccess,
  call: async () => { throw Error("unexpected storage call"); },
});
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "lichtblick-asset-lease-"));
  const root = path.join(parent, "assets");
  await fs.mkdir(root, { mode: 0o700 });
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, root };
}
const childProgram = `
  const { createManagedDomainClient } = require(process.argv[1]);
  const client = createManagedDomainClient({
    scope: { namespace: "lichtblick", user: "asset-test", workspace: "lease" },
    assetRoot: process.argv[2], assetAccess: process.argv[3],
    call: async () => { throw Error("unexpected storage call"); },
  });
  (async () => {
    await client.ready;
    const asset = process.argv[4]
      ? JSON.parse(process.argv[4])
      : await client.publish(Buffer.from("durable extension"), { id: "publisher.camera", version: "1" });
    const bytes = await client.load(asset);
    process.stdout.write(JSON.stringify({ ready: true, asset, content: Buffer.from(bytes).toString() }) + "\\n");
    process.stdin.resume();
    process.stdin.once("data", async () => { await client.close(); process.exit(0); });
  })().catch(async (error) => {
    process.stdout.write(JSON.stringify({ error: error.code, message: error.message }) + "\\n");
    await client.close(); process.exit(1);
  });
`;
function startChild(t, root, access = "read-write", asset) {
  const child = spawn(process.execPath, ["-e", childProgram, path.resolve(__dirname, "../launcher/managed-storage.cjs"), root, access, ...(asset ? [JSON.stringify(asset)] : [])], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.on("data", (bytes) => {
      output += bytes.toString();
      const end = output.indexOf("\n");
      if (end >= 0) {
        const result = JSON.parse(output.slice(0, end));
        if (result.error) reject(Object.assign(new Error(result.message), { code: result.error }));
        else resolve(result);
      }
    });
    child.once("exit", () => { if (!output.includes("\n")) reject(new Error("asset owner exited without readiness")); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return { child, ready, exited, close: async () => { child.stdin.end("close\n"); return await exited; } };
}

test("a native writer retains the flock after its helper exits; another process loses until close", { timeout: 15000 }, async (t) => {
  const { root } = await fixture(t);
  const first = startChild(t, root);
  await first.ready;
  assert.equal((await fs.readFile(`/proc/${first.child.pid}/task/${first.child.pid}/children`, "utf8")).trim(), "", "flock helper must exit at readiness");
  const loser = startChild(t, root);
  await assert.rejects(loser.ready, (error) => error.code === "conflict");
  assert.equal((await loser.exited).code, 1);
  assert.equal((await first.close()).code, 0);
  const replacement = startChild(t, root);
  await replacement.ready;
  assert.equal((await replacement.close()).code, 0);
});

test("SIGKILL recovers the kernel lease and an independent reader loads during the writer lifetime", { timeout: 15000 }, async (t) => {
  const { root } = await fixture(t);
  const writer = startChild(t, root);
  const original = await writer.ready;
  const reader = startChild(t, root, "read-only", original.asset);
  assert.equal((await reader.ready).content, "durable extension");
  assert.equal((await reader.close()).code, 0);
  const before = await fs.readdir(root);
  const localReader = createManagedDomainClient(options(root, "read-only"));
  await localReader.ready;
  t.after(() => localReader.close());
  await assert.rejects(localReader.publish(Buffer.from("blocked"), { id: "reader", version: "1" }), (error) => error.code === "permission_denied");
  assert.deepEqual(await fs.readdir(root), before, "reader must not create files");
  writer.child.kill("SIGKILL");
  assert.equal((await writer.exited).signal, "SIGKILL");
  const recovered = startChild(t, root);
  await recovered.ready;
  assert.equal((await recovered.close()).code, 0);
});

test("control files reject symbolic links, loose permissions and hard links without leaking handles", async (t) => {
  const { parent, root } = await fixture(t);
  const external = path.join(parent, "external");
  await fs.writeFile(external, "unmodified", { mode: 0o600 });
  await fs.symlink(external, path.join(root, LOCK));
  let client = createManagedDomainClient(options(root));
  await assert.rejects(client.ready, (error) => error.code === "ELOOP");
  await client.close();
  assert.equal(await fs.readFile(external, "utf8"), "unmodified");
  await fs.unlink(path.join(root, LOCK));
  await fs.writeFile(path.join(root, LOCK), "", { mode: 0o644 });
  client = createManagedDomainClient(options(root));
  await assert.rejects(client.ready, /private, regular and owned/);
  await client.close();
  await fs.unlink(path.join(root, LOCK));
  await fs.link(external, path.join(root, LOCK));
  client = createManagedDomainClient(options(root));
  await assert.rejects(client.ready, /private, regular and owned/);
  await client.close();
  await fs.unlink(path.join(root, LOCK));
  client = createManagedDomainClient(options(root));
  await client.ready;
  await client.close();
});

test("a failed inventory and close during initialization release the actual native lease", async (t) => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, "undeclared-directory"));
  const failed = createManagedDomainClient(options(root));
  await assert.rejects(failed.ready, /undeclared entry/);
  assert.equal(failed.assetWriter, undefined);
  assert.equal(failed.assetDirectory, undefined);
  await failed.close();
  await fs.rmdir(path.join(root, "undeclared-directory"));
  const closing = createManagedDomainClient(options(root));
  await closing.close();
  assert.equal(closing.assetWriter, undefined);
  assert.equal(closing.assetDirectory, undefined);
  const next = createManagedDomainClient(options(root));
  await next.ready;
  await next.close();
});

test("grant replacement during publication writes only through the anchored descriptor and rejects success", async (t) => {
  const { parent, root } = await fixture(t);
  const moved = path.join(parent, "original-assets");
  const client = createManagedDomainClient(options(root));
  await client.ready;
  t.after(() => client.close());
  const open = fs.open;
  let replaced = false;
  t.mock.method(fs, "open", async (target, ...arguments_) => {
    if (!replaced && typeof target === "string" && target.endsWith(".pending")) {
      replaced = true;
      await fs.rename(root, moved);
      await fs.mkdir(root, { mode: 0o700 });
    }
    return await open(target, ...arguments_);
  });
  await assert.rejects(client.publish(Buffer.from("anchored bytes"), { id: "camera", version: "1" }), /grant directory was replaced/);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await fs.readdir(moved)).filter((name) => name.endsWith(".foxe")).length, 1);
  await assert.rejects(client.load({ owner: "lichtblick", asset_id: "missing", bytes: 1, sha256: "0".repeat(64) }), /grant directory was replaced/);
});

test("replacing the control inode cannot let the old owner continue publishing", async (t) => {
  const { root } = await fixture(t);
  const client = createManagedDomainClient(options(root));
  await client.ready;
  t.after(() => client.close());
  await fs.unlink(path.join(root, LOCK));
  await fs.writeFile(path.join(root, LOCK), "", { mode: 0o600 });
  await assert.rejects(client.publish(Buffer.from("blocked"), { id: "camera", version: "1" }), /control lock was replaced/);
  assert.deepEqual(await fs.readdir(root), [LOCK]);
});

test("close drains an admitted publication before releasing the writer and rejects new work", async (t) => {
  const { root } = await fixture(t);
  const client = createManagedDomainClient(options(root));
  await client.ready;
  const open = fs.open;
  let entered;
  const inWrite = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, "open", async (target, ...arguments_) => {
    const handle = await open(target, ...arguments_);
    if (typeof target === "string" && target.endsWith(".pending")) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => { entered(); await gate; return await write(bytes); };
    }
    return handle;
  });
  const publishing = client.publish(Buffer.from("in-flight archive"), { id: "camera", version: "1" });
  await inWrite;
  const closing = client.close();
  const contender = createManagedDomainClient(options(root));
  await assert.rejects(contender.ready, (error) => error.code === "conflict");
  await contender.close();
  await assert.rejects(client.load({ owner: "lichtblick", asset_id: "missing", bytes: 1, sha256: "0".repeat(64) }), /owner is closing/);
  release();
  const asset = await publishing;
  await closing;
  const next = createManagedDomainClient(options(root));
  await next.ready;
  assert.equal(next.assetCount, 1, "fixed control inode is not an archive quota charge");
  assert.equal(Buffer.from(await next.load(asset)).toString(), "in-flight archive");
  await next.close();
});
