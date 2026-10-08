// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PropsWithChildren, useEffect, useRef, useState } from "react";

import Log from "@lichtblick/log";
import { StudioLogsSettingsContext } from "@lichtblick/suite-base/context/StudioLogsSettingsContext";
import { getManagedDocumentStore } from "@lichtblick/suite-base/services/persistence/ManagedPersistence";

import { createStudioLogsSettingsStore } from "./store";
import { SavedLogSettings } from "./types";

function StudioLogsSettingsProvider(props: PropsWithChildren): React.JSX.Element {
  const documents = getManagedDocumentStore();
  const studioLogsSettingsSavedState = documents.get<SavedLogSettings>("workspace", "log-settings");

  const [studioLogsSettingsStore, setStudioLogsSettingsStore] = useState(() =>
    createStudioLogsSettingsStore(studioLogsSettingsSavedState),
  );

  // To avoid resetting effect below when the loaded state changes we use a ref for the loaded state
  const savedStateRef = useRef<SavedLogSettings | undefined>(studioLogsSettingsSavedState);

  // Setup an interval to check for changes to the total number of logging channels
  //
  // When the total number of channels changes we re-initialize the settings store so we display any
  // newly added log channels.
  useEffect(() => {
    const storeChannelsCount = studioLogsSettingsStore.getState().channels.length;
    const intervalHandle = setInterval(() => {
      if (storeChannelsCount !== Log.channels().length) {
        setStudioLogsSettingsStore(createStudioLogsSettingsStore(savedStateRef.current));
      }
    }, 1000);

    return () => {
      clearInterval(intervalHandle);
    };
  }, [studioLogsSettingsStore]);

  useEffect(() => {
    return studioLogsSettingsStore.subscribe((value) => {
      const disabledChannels: string[] = [];

      for (const channel of value.channels) {
        if (!channel.enabled) {
          disabledChannels.push(channel.name);
        }
      }
      const settings = { globalLevel: value.globalLevel, disabledChannels };
      savedStateRef.current = settings;
      void documents
        .commit([{ family: "workspace", key: "log-settings", value: settings }])
        .catch((error: unknown) => {
          console.error(error);
        });
    });
  }, [studioLogsSettingsStore, documents]);

  return (
    <StudioLogsSettingsContext.Provider value={studioLogsSettingsStore}>
      {props.children}
    </StudioLogsSettingsContext.Provider>
  );
}

export { StudioLogsSettingsProvider };
