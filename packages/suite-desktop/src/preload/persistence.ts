// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ManagedRequestError } from "@lichtblick/suite-base/src/services/persistence/ManagedDocumentStore";

import { managedIPCFailure } from "../common/managedIPC";
import type { ManagedIPCReply, PersistenceBridge } from "../common/types";

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Bound the payload before Electron copies it into the main process. */
export function createPersistenceBridge(invoke: Invoke): PersistenceBridge {
  async function call<T>(
    channel: string,
    args: unknown[],
    validate: () => void,
  ): Promise<ManagedIPCReply<T>> {
    try {
      validate();
    } catch (error) {
      return managedIPCFailure(
        error instanceof ManagedRequestError
          ? error
          : new ManagedRequestError(
              "Invalid managed IPC payload",
              "invalid_request",
              "not_sent",
            ),
      );
    }
    try {
      return (await invoke(channel, ...args)) as ManagedIPCReply<T>;
    } catch (error) {
      return managedIPCFailure(error);
    }
  }
  return {
    async domainRequest(request) {
      return await call("managed-domain-request", [request], () => {
        if (
          !["snapshot", "batch", "receipt"].includes(request.operation) ||
          Buffer.byteLength(JSON.stringify(request), "utf8") > 4 * 1024 * 1024
        ) {
          throw new ManagedRequestError(
            "Invalid or oversized domain request",
            "invalid_request",
            "not_sent",
          );
        }
      });
    },
    async publish(bytes, info) {
      return await call("managed-extension-publish", [bytes, info], () => {
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength === 0 ||
          bytes.byteLength > 8 * 1024 * 1024 ||
          typeof info.id !== "string" ||
          info.id.length > 256 ||
          typeof info.version !== "string" ||
          info.version.length > 128
        ) {
          throw new ManagedRequestError(
            "Invalid extension archive publication",
            "invalid_request",
            "not_sent",
          );
        }
      });
    },
    async load(asset) {
      return await call("managed-extension-load", [asset], () => {
        if (
          (asset.owner as string) !== "lichtblick" ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(asset.asset_id) ||
          !/^[0-9a-f]{64}$/.test(asset.sha256) ||
          !Number.isSafeInteger(asset.bytes) ||
          asset.bytes <= 0 ||
          asset.bytes > 8 * 1024 * 1024
        ) {
          throw new ManagedRequestError(
            "Invalid extension asset reference",
            "invalid_request",
            "not_sent",
          );
        }
      });
    },
  };
}
