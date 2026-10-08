// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AppSetting } from "@lichtblick/suite-base/src/AppSetting";
import type { ManagedRequest } from "@lichtblick/suite-base/src/services/persistence/ManagedDocumentStore";

import {
  getAppSetting,
  initializeAppSettings,
  observeCommittedSettings,
} from "./settings";

const token = {
  database_id: "desktop-test",
  schema: "lichtblick-v1",
  revision: "4",
};
const key = AppSetting.COLOR_SCHEME;
const batch = (
  value: unknown,
  expectedVersion = "2",
): Extract<ManagedRequest, { operation: "batch" }> => ({
  operation: "batch",
  expected: token,
  requestId: "request-a",
  changes: [{ family: "configuration", key, expectedVersion, value }],
});
const receipt = (version: string, revision = "5") => ({
  token: { ...token, revision },
  requestId: "request-a",
  durability: "sqlite-full",
  versions: [{ family: "configuration", key, version }],
});

beforeEach(async () => {
  await initializeAppSettings(async () => {
    return {
      token,
      records: [{ family: "configuration", key, version: "2", value: "light" }],
    };
  });
});

it("requires a successful managed snapshot and preserves it on a failed reload", async () => {
  expect(getAppSetting(key)).toBe("light");
  await expect(
    initializeAppSettings(async () => {
      throw new Error("storage unavailable");
    }),
  ).rejects.toThrow("storage unavailable");
  expect(getAppSetting(key)).toBe("light");
});

it("updates the native projection only after a fenced durable receipt", () => {
  expect(() => {
    observeCommittedSettings(batch("dark"), {
      ...receipt("3"),
      durability: "memory",
    });
  }).toThrow("receipt");
  expect(getAppSetting(key)).toBe("light");
  observeCommittedSettings(batch("dark"), receipt("3"));
  expect(getAppSetting(key)).toBe("dark");
});

it.each([
  { ...receipt("3"), requestId: "another-request" },
  {
    ...receipt("3"),
    token: { ...token, database_id: "another-database", revision: "5" },
  },
  { ...receipt("3"), versions: [] },
  receipt("2"),
  receipt("03"),
  receipt("3", "4"),
])("rejects an unrelated or stale acknowledgement", (result) => {
  expect(() => {
    observeCommittedSettings(batch("dark"), result);
  }).toThrow();
  expect(getAppSetting(key)).toBe("light");
});

it("does not regress when an earlier committed reply arrives later", () => {
  observeCommittedSettings(batch("dark", "3"), receipt("4", "6"));
  observeCommittedSettings(batch("light"), receipt("3"));
  expect(getAppSetting(key)).toBe("dark");
});

it("retains a deletion version so a late reply cannot restore deleted settings", () => {
  const deleted = batch(undefined, "3");
  deleted.changes = [
    { family: "configuration", key, expectedVersion: "3", delete: true },
  ];
  observeCommittedSettings(deleted, receipt("4", "6"));
  observeCommittedSettings(batch("dark"), receipt("3"));
  expect(getAppSetting(key)).toBeUndefined();
});
