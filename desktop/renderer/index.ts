// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AppSetting } from "@lichtblick/suite-base";
import { ManagedAppConfiguration } from "@lichtblick/suite-base/src/services/persistence/ManagedAppConfiguration";
import { initializeManagedPersistence } from "@lichtblick/suite-base/src/services/persistence/ManagedPersistence";

import { unwrapManagedIPC } from "../../packages/suite-desktop/src/common/managedIPC";
import { PersistenceBridge } from "../../packages/suite-desktop/src/common/types";
import { main as rendererMain } from "../../packages/suite-desktop/src/renderer/index";

const isDevelopment = process.env.NODE_ENV === "development";

async function main() {
  const bridge = (global as { persistenceBridge?: PersistenceBridge })
    .persistenceBridge;
  if (!bridge) {
    throw new Error("Managed persistence bridge is missing");
  }
  const store = await initializeManagedPersistence(
    async (request) => unwrapManagedIPC(await bridge.domainRequest(request)),
    {
      publish: async (bytes, info) =>
        unwrapManagedIPC(await bridge.publish(bytes, info)),
      load: async (asset) => unwrapManagedIPC(await bridge.load(asset)),
    },
  );
  const appConfiguration = new ManagedAppConfiguration(store, {
    [AppSetting.SHOW_DEBUG_PANELS]: isDevelopment,
  });

  await rendererMain({ appConfiguration });
}

void main();
