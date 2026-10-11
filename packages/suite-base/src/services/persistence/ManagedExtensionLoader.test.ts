// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import JSZip from "jszip";
import { createHash } from "node:crypto";

import { CoreUiDocumentAssets } from "./CoreUiDocumentAssets";
import { CoreUiDocumentClient, encodeCoreUiKey } from "./CoreUiDocumentClient";
import { CoreUiDocumentStore } from "./CoreUiDocumentStore";
import { ManagedExtensionLoader, unpackManagedExtension } from "./ManagedExtensionLoader";
import { ManagedAssetReference, ManagedAssetTransport } from "./ManagedPersistence";
import { CoreUiDocumentServer } from "./test/CoreUiDocumentServer";

async function archive(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "package.json",
    JSON.stringify({ name: "example", publisher: "tests", version: "1.0.0" })!,
  );
  zip.file("dist/extension.js", "module.exports = {};");
  return await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
function reference(bytes: Uint8Array): ManagedAssetReference {
  return {
    owner: "lichtblick",
    asset_id: encodeCoreUiKey('["tests.example","1.0.0"]'),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
it("publishes verified bytes before committing the installed pointer", async () => {
  const bytes = await archive();
  const events: string[] = [];
  const store = new CoreUiDocumentStore();
  const commit = jest.spyOn(store, "commit").mockImplementation(async () => {
    events.push("commit");
  });
  const assets: ManagedAssetTransport = {
    publish: async () => {
      events.push("publish");
      return reference(bytes);
    },
    load: jest.fn(),
  };
  const info = await new ManagedExtensionLoader("local", store, assets).installExtension({
    foxeFileData: bytes,
  });
  expect(events).toEqual(["publish", "commit"]);
  expect(info.id).toBe("tests.example");
  expect(commit.mock.calls[0]?.[0]).toEqual([
    {
      family: "extensions",
      key: '["local","tests.example"]',
      value: { info, asset: reference(bytes) },
    },
  ]);
});
it("failed publication and checksum mismatch never switch installed metadata", async () => {
  const bytes = await archive();
  const store = new CoreUiDocumentStore();
  const commit = jest.spyOn(store, "commit");
  const assets: ManagedAssetTransport = {
    publish: jest.fn().mockRejectedValue(new Error("disk full")),
    load: jest.fn(),
  };
  await expect(
    new ManagedExtensionLoader("local", store, assets).installExtension({ foxeFileData: bytes }),
  ).rejects.toThrow("disk full");
  assets.publish = jest.fn().mockResolvedValue({ ...reference(bytes), sha256: "0".repeat(64) });
  await expect(
    new ManagedExtensionLoader("local", store, assets).installExtension({ foxeFileData: bytes }),
  ).rejects.toThrow("integrity");
  expect(commit).not.toHaveBeenCalled();
});
it("installs and restores an extension through Core and refuses corrupted archive bytes", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  const assets = new CoreUiDocumentAssets(client);
  const loader = new ManagedExtensionLoader("local", store, assets);
  const info = await loader.installExtension({ foxeFileData: await archive() });
  const fresh = new CoreUiDocumentStore(client);
  await fresh.bootstrap();
  const restored = new ManagedExtensionLoader("local", fresh, assets);
  expect(await restored.getExtensions()).toEqual([info]);
  expect(await restored.loadExtension(info.id)).toEqual({ raw: "module.exports = {};" });
  server.assets.values().next().value!.bytes[0] = 99;
  await expect(restored.loadExtension(info.id)).rejects.toThrow("integrity check");
  await restored.uninstallExtension(info.id);
  expect(await restored.getExtensions()).toEqual([]);
});
it("expanded size and entry count are rejected before inflation", async () => {
  const bytes = await archive();
  const changed = bytes.slice();
  const data = new DataView(changed.buffer);
  let central = 0;
  while (central < changed.length - 4 && data.getUint32(central, true) !== 0x02014b50) {
    central++;
  }
  data.setUint32(central + 24, 64 * 1024 * 1024 + 1, true);
  await expect(unpackManagedExtension(changed)).rejects.toThrow("expanded size");
  const end = changed.length - 22;
  data.setUint16(end + 8, 257, true);
  data.setUint16(end + 10, 257, true);
  await expect(unpackManagedExtension(changed)).rejects.toThrow("ZIP directory");
});
it("a dishonest compressed entry cannot bypass the actual inflation limit", async () => {
  const zip = new JSZip();
  zip.file("package.json", "a".repeat(256 * 1024 + 1));
  zip.file("dist/extension.js", "module.exports={};");
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await expect(unpackManagedExtension(bytes)).rejects.toThrow("expanded size limit");
});
