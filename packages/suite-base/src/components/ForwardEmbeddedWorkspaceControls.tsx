// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { PropsWithChildren, useContext, useLayoutEffect, useState } from "react";
import { StoreApi, createStore, useStore } from "zustand";

import { EmbeddedWorkspaceControlsContext } from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";

type Controls = React.ContextType<typeof EmbeddedWorkspaceControlsContext>;
export type ForwardedEmbeddedWorkspaceControls = StoreApi<{ value: Controls }>;

/** A stable bridge across the built-in panel's independent React root. */
export function useForwardEmbeddedWorkspaceControls(): ForwardedEmbeddedWorkspaceControls {
  const value = useContext(EmbeddedWorkspaceControlsContext);
  const [store] = useState(() => createStore(() => ({ value })));
  useLayoutEffect(() => {
    store.setState({ value });
  }, [store, value]);
  return store;
}

export function ForwardEmbeddedWorkspaceControls({
  store,
  children,
}: PropsWithChildren<{
  store: ForwardedEmbeddedWorkspaceControls;
}>): React.JSX.Element {
  const { value } = useStore(store);
  return (
    <EmbeddedWorkspaceControlsContext.Provider value={value}>
      {children}
    </EmbeddedWorkspaceControlsContext.Provider>
  );
}
