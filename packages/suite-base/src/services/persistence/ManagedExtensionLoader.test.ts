// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import JSZip from "jszip";
import { createHash } from "node:crypto";

import { ManagedDocumentStore } from "./ManagedDocumentStore";
import { ManagedExtensionLoader, unpackManagedExtension } from "./ManagedExtensionLoader";
import { ManagedAssetReference, ManagedAssetTransport } from "./ManagedPersistence";

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
    asset_id: "tests.example-1.0.0-abc",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
it("publishes verified immutable bytes before committing the installed pointer", async () => {
  const bytes = await archive();
  const events: string[] = [];
  const store = new ManagedDocumentStore(jest.fn());
  const commit = jest.spyOn(store, "commit").mockImplementation(async () => {
    events.push("commit");
    return {
      token: { database_id: "fixture", schema: "test", revision: "1" },
      requestId: "save",
      durability: "sqlite-full",
      versions: [],
    };
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
  const store = new ManagedDocumentStore(jest.fn());
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
