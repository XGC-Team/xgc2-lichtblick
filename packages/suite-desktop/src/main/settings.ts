// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AppSetting } from "../../../suite-base/src/AppSetting";
import {
  ManagedDocumentStore,
  ManagedRequest,
  ManagedTransport,
} from "../../../suite-base/src/services/persistence/ManagedDocumentStore";

let configuration:
  | Map<string, { value?: unknown; version: string; deleted?: boolean }>
  | undefined;

/** Main's read-only projection is loaded before creating any native windows. */
export async function initializeAppSettings(
  transport: ManagedTransport,
): Promise<void> {
  const store = new ManagedDocumentStore(transport);
  await store.bootstrap(["configuration"]);
  configuration = new Map(
    store
      .records("configuration")
      .map(({ key, value, version }) => [key, { value, version }]),
  );
}

export function getAppSetting<T>(key: AppSetting): T | undefined {
  if (!configuration) {
    throw new Error(
      "Managed app settings must load before native initialization",
    );
  }
  const record = configuration.get(key);
  return record?.deleted === true
    ? undefined
    : (structuredClone(record?.value) as T | undefined);
}

/** Project an acknowledged product batch without a second persistent writer. */
export function observeCommittedSettings(
  request: ManagedRequest,
  receipt: unknown,
): void {
  if (request.operation !== "batch") {
    return;
  }
  const value = receipt as
    | {
        requestId?: unknown;
        durability?: unknown;
        token?: { database_id?: unknown; schema?: unknown; revision?: unknown };
        versions?: unknown;
      }
    | undefined;
  if (
    !value?.token ||
    value.requestId !== request.requestId ||
    value.durability !== "sqlite-full" ||
    value.token.database_id !== request.expected.database_id ||
    value.token.schema !== request.expected.schema ||
    typeof value.token.revision !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.token.revision) ||
    BigInt(value.token.revision) <= BigInt(request.expected.revision) ||
    !Array.isArray(value.versions) ||
    value.versions.length !== request.changes.length
  ) {
    throw new Error("Invalid managed commit receipt");
  }
  const versions = new Map(
    request.changes.map((change) => [
      JSON.stringify([change.family, change.key]),
      change.expectedVersion,
    ]),
  );
  for (const version of value.versions as {
    family: string;
    key: string;
    version: unknown;
  }[]) {
    const id = JSON.stringify([version.family, version.key]);
    const previous = versions.get(id);
    if (
      previous == undefined ||
      typeof version.version !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(version.version) ||
      BigInt(version.version) <= BigInt(previous)
    ) {
      throw new Error("Invalid managed commit versions");
    }
    versions.delete(id);
  }
  if (!configuration) {
    throw new Error("Managed app settings have not loaded");
  }
  for (const change of request.changes) {
    if (change.family === "configuration") {
      const version = (
        value.versions as { family: string; key: string; version: string }[]
      ).find(
        (record) =>
          record.family === change.family && record.key === change.key,
      )!.version;
      const existingVersion = configuration.get(change.key)?.version ?? "0";
      if (BigInt(version) > BigInt(existingVersion)) {
        configuration.set(change.key, {
          version,
          ...(change.delete === true
            ? { deleted: true }
            : { value: structuredClone(change.value) }),
        });
      }
    }
  }
}
