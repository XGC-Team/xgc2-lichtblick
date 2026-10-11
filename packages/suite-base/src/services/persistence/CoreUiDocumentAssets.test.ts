// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";

import { CoreUiDocumentAssets } from "./CoreUiDocumentAssets";
import { CoreUiDocumentClient, decodeCoreUiKey } from "./CoreUiDocumentClient";
import { CoreUiDocumentServer } from "./test/CoreUiDocumentServer";

it("publishes raw bytes and loads them with a browser length and SHA-256 check", async () => {
  const server = new CoreUiDocumentServer();
  const assets = new CoreUiDocumentAssets(new CoreUiDocumentClient(server.fetch));
  const bytes = new Uint8Array([0, 1, 255]);
  const info = { id: "Tests.Example", version: "1.2.3+Build" };
  const asset = await assets.publish(bytes, info);
  expect(JSON.parse(decodeCoreUiKey(asset.asset_id))).toEqual([info.id, info.version]);
  expect(asset).toMatchObject({
    owner: "lichtblick",
    bytes: 3,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(await assets.load(asset)).toEqual(bytes);
  expect(server.requests[0]?.options).toMatchObject({
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    credentials: "same-origin",
  });
  expect(server.requests[1]?.url.search).toBe("");
  expect(server.requests[1]?.url.pathname).toBe(
    `/api/ui-documents/lichtblick/assets/${asset.asset_id}`,
  );
});

it("rejects modified bytes, length mismatches and invalid references", async () => {
  const server = new CoreUiDocumentServer();
  const assets = new CoreUiDocumentAssets(new CoreUiDocumentClient(server.fetch));
  const asset = await assets.publish(new Uint8Array([1, 2, 3]), {
    id: "tests.example",
    version: "1.0.0",
  });
  server.assets.get(asset.asset_id)!.bytes[0] = 99;
  await expect(assets.load(asset)).rejects.toThrow("integrity check");
  await expect(assets.load({ ...asset, bytes: 4 })).rejects.toThrow(
    "Invalid extension asset reference",
  );
  await expect(assets.load({ ...asset, asset_id: "../unsafe" })).rejects.toThrow(
    "encoded UI document key",
  );
});

it("keeps the page's 8 MiB limit below Core's asset bound", async () => {
  const server = new CoreUiDocumentServer();
  const assets = new CoreUiDocumentAssets(new CoreUiDocumentClient(server.fetch));
  const info = { id: "tests.example", version: "1.0.0" };
  await expect(assets.publish(new Uint8Array(8 * 1024 * 1024 + 1), info)).rejects.toThrow("8 MiB");
  expect(server.requests).toHaveLength(0);
  const asset = await assets.publish(new Uint8Array(8 * 1024 * 1024), info);
  expect(asset.bytes).toBe(8 * 1024 * 1024);
  server.assets.get(asset.asset_id)!.bytes = new Uint8Array(8 * 1024 * 1024 + 1);
  await expect(assets.load(asset)).rejects.toThrow("size limit");
});

it("refuses publication when Core's app quota is exhausted", async () => {
  const server = new CoreUiDocumentServer();
  server.maxBytes = 1;
  const assets = new CoreUiDocumentAssets(new CoreUiDocumentClient(server.fetch));
  await expect(
    assets.publish(new Uint8Array([1, 2]), { id: "tests.example", version: "1.0.0" }),
  ).rejects.toMatchObject({ code: "quota_exceeded" });
  expect(server.assets.size).toBe(0);
});
