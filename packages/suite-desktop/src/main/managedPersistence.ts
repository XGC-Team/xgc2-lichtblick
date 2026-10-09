// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ipcMain } from "electron";

import type { ManagedRequest } from "../../../suite-base/src/services/persistence/ManagedDocumentStore";
import { ManagedRequestError } from "../../../suite-base/src/services/persistence/ManagedDocumentStore";

import StudioWindow from "./StudioWindow";
import { observeCommittedSettings } from "./settings";
import type { ManagedDomainClient } from "../../../../xgc2/launcher/managed-storage.cjs";
import { managedIPCFailure } from "../common/managedIPC";
import type { ManagedIPCReply } from "../common/types";

/** One bounded main-process admission path; no arbitrary filesystem IPC. */
export function registerManagedPersistenceIPC(
  client: ManagedDomainClient,
): void {
  let active = 0;
  async function invoke<T>(
    event: Electron.IpcMainInvokeEvent,
    call: () => Promise<T>,
  ): Promise<ManagedIPCReply<T>> {
    try {
      if (
        !StudioWindow.fromWebContentsId(event.sender.id) ||
        event.senderFrame !== event.sender.mainFrame ||
        !StudioWindow.isRendererURL(event.senderFrame.url)
      ) {
        throw new ManagedRequestError(
          "Managed persistence is restricted to the desktop renderer",
          "forbidden",
          "not_sent",
        );
      }
      if (active >= 8) {
        throw new ManagedRequestError(
          "Desktop persistence admission is full",
          "overloaded",
          "not_sent",
        );
      }
      active++;
      try {
        return { ok: true, value: await call() };
      } finally {
        active--;
      }
    } catch (error) {
      return managedIPCFailure(error);
    }
  }

  ipcMain.handle(
    "managed-domain-request",
    async (event, input: ManagedRequest) =>
      await invoke(event, async () => {
        const request = structuredClone(input);
        const receipt = await client.request(request);
        observeCommittedSettings(request, receipt);
        return receipt;
      }),
  );
  ipcMain.handle(
    "managed-extension-publish",
    async (event, bytes: Uint8Array, info: { id: string; version: string }) =>
      await invoke(event, async () => await client.publish(bytes, info)),
  );
  ipcMain.handle(
    "managed-extension-load",
    async (event, asset: Parameters<ManagedDomainClient["load"]>[0]) =>
      await invoke(event, async () => await client.load(asset)),
  );
}
