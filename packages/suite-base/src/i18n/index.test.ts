/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
import { initI18n, sharedI18nObject } from "./index";

it("initialization and language changes do not consult browser storage", async () => {
  const read = jest.spyOn(Storage.prototype, "getItem");
  const write = jest.spyOn(Storage.prototype, "setItem");
  await initI18n();
  await sharedI18nObject.changeLanguage("en");
  expect(sharedI18nObject.t("foxglove")).toBeDefined();
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it("main initializes translation resources without a detector", async () => {
  await initI18n({ context: "electron-main" });
  expect(sharedI18nObject.options.detection).toBeUndefined();
});
