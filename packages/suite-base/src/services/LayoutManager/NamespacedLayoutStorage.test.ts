// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
import { NamespacedLayoutStorage } from "./NamespacedLayoutStorage";
import { ILayoutStorage } from "../ILayoutStorage";

function backend(): jest.Mocked<ILayoutStorage> {
  return {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    importLayouts: jest.fn().mockResolvedValue(undefined),
  };
}
it("namespace reads wait for the atomic import", async () => {
  const storage = backend();
  const imported = jest.spyOn(storage, "importLayouts");
  const listed = jest.spyOn(storage, "list");
  const scoped = new NamespacedLayoutStorage(storage, "workspace", {
    importFromNamespace: "local",
  });
  await scoped.list();
  expect(imported).toHaveBeenCalledWith({
    fromNamespace: "local",
    toNamespace: "workspace",
  });
  expect(listed).toHaveBeenCalledWith("workspace");
});
it("failed import does not expose an empty namespace", async () => {
  const storage = backend();
  const listed = jest.spyOn(storage, "list");
  storage.importLayouts.mockRejectedValue(new Error("conflict"));
  const scoped = new NamespacedLayoutStorage(storage, "workspace", {
    importFromNamespace: "local",
  });
  await expect(scoped.list()).rejects.toThrow("conflict");
  expect(listed).not.toHaveBeenCalled();
});
