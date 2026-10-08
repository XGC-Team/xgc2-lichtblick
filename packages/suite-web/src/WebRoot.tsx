// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useMemo, useState } from "react";

import {
  AppBarProps,
  AppSetting,
  IExtensionLoader,
  FoxgloveWebSocketDataSourceFactory,
  IDataSourceFactory,
  ManagedExtensionLoader,
  McapLocalDataSourceFactory,
  RemoteDataSourceFactory,
  Ros1LocalBagDataSourceFactory,
  Ros2LocalBagDataSourceFactory,
  RosbridgeDataSourceFactory,
  SampleNuscenesDataSourceFactory,
  SharedRoot,
  UlogLocalDataSourceFactory,
  type WorkspaceAppearance,
} from "@lichtblick/suite-base";
import { AppParametersInput } from "@lichtblick/suite-base/context/AppParametersContext";
import { ManagedAppConfiguration } from "@lichtblick/suite-base/services/persistence/ManagedAppConfiguration";
import { getManagedDocumentStore } from "@lichtblick/suite-base/services/persistence/ManagedPersistence";

const isDevelopment = process.env.NODE_ENV === "development";

export function WebRoot(props: {
  extraProviders: React.JSX.Element[] | undefined;
  dataSources: IDataSourceFactory[] | undefined;
  AppBarComponent?: (props: AppBarProps) => React.JSX.Element;
  children: React.JSX.Element;
}): React.JSX.Element {
  const appConfiguration = useMemo(
    () =>
      new ManagedAppConfiguration(getManagedDocumentStore(), {
        [AppSetting.SHOW_DEBUG_PANELS]: isDevelopment,
      }),
    [],
  );

  const url = new URL(globalThis.location.href);
  const workspaceAppearance: WorkspaceAppearance =
    url.searchParams.get("xgc2Embed") === "1" ? "embedded" : "standard";
  // Embedded workspaces use the panels compiled into this bundle.
  const defaultExtensionLoaders: IExtensionLoader[] =
    workspaceAppearance === "embedded"
      ? []
      : [new ManagedExtensionLoader("org"), new ManagedExtensionLoader("local")];

  const [extensionLoaders] = useState(() => defaultExtensionLoaders);

  const layout = url.searchParams.get("layout");
  const [appParameters] = useState<AppParametersInput>(() => {
    const params: Record<string, string> = {};
    if (layout != undefined && layout !== "") {
      params.defaultLayout = layout;
    }
    return params;
  });

  const dataSources = useMemo(() => {
    const sources = [
      new Ros1LocalBagDataSourceFactory(),
      new Ros2LocalBagDataSourceFactory(),
      new FoxgloveWebSocketDataSourceFactory(),
      new RosbridgeDataSourceFactory(),
      new UlogLocalDataSourceFactory(),
      new SampleNuscenesDataSourceFactory(),
      new McapLocalDataSourceFactory(),
      new RemoteDataSourceFactory(),
    ];

    return props.dataSources ?? sources;
  }, [props.dataSources]);

  return (
    <SharedRoot
      enableLaunchPreferenceScreen={workspaceAppearance === "standard"}
      deepLinks={[globalThis.location.href]}
      dataSources={dataSources}
      appConfiguration={appConfiguration}
      appParameters={appParameters}
      extensionLoaders={extensionLoaders}
      enableGlobalCss
      extraProviders={props.extraProviders}
      AppBarComponent={props.AppBarComponent}
      workspaceAppearance={workspaceAppearance}
    >
      {props.children}
    </SharedRoot>
  );
}
