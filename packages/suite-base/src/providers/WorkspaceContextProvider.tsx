// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import { ReactNode, useEffect, useState } from "react";
import { StoreApi, createStore } from "zustand";

import {
  WorkspaceContext,
  WorkspaceContextStore,
} from "@lichtblick/suite-base/context/Workspace/WorkspaceContext";
import { getManagedDocumentStore } from "@lichtblick/suite-base/services/persistence/ManagedPersistence";

/**
 * Creates the default initial state for the workspace store.
 */
export function makeWorkspaceContextInitialState(): WorkspaceContextStore {
  return {
    dialogs: {
      dataSource: {
        activeDataSource: undefined,
        item: undefined,
        open: false,
      },
      preferences: {
        initialTab: undefined,
        open: false,
      },
    },
    featureTours: {
      active: undefined,
      shown: [],
    },
    layoutBrowser: {
      expandedSections: {
        personal: true,
        shared: true,
      },
    },
    sidebars: {
      left: {
        item: "panel-settings",
        open: true,
        size: undefined,
      },
      right: {
        item: undefined,
        open: false,
        size: undefined,
      },
    },
    playbackControls: {
      repeat: false,
      syncInstances: false,
    },
  };
}

function createWorkspaceContextStore(
  initialState?: Partial<WorkspaceContextStore>,
  options?: { disablePersistenceForStorybook?: boolean },
): StoreApi<WorkspaceContextStore> {
  const persisted =
    options?.disablePersistenceForStorybook === true
      ? undefined
      : getManagedDocumentStore().get<Partial<WorkspaceContextStore>>("workspace", "ui");
  return createStore<WorkspaceContextStore>()(() =>
    _.merge({}, makeWorkspaceContextInitialState(), persisted, initialState),
  );
}

export default function WorkspaceContextProvider(props: {
  children?: ReactNode;
  disablePersistenceForStorybook?: boolean;
  initialState?: Partial<WorkspaceContextStore>;
  workspaceStoreCreator?: (
    initialState?: Partial<WorkspaceContextStore>,
    options?: { disablePersistenceForStorybook?: boolean },
  ) => StoreApi<WorkspaceContextStore>;
}): React.JSX.Element {
  const { children, initialState, workspaceStoreCreator, disablePersistenceForStorybook } = props;

  const [store] = useState(() =>
    workspaceStoreCreator
      ? workspaceStoreCreator(initialState, { disablePersistenceForStorybook })
      : createWorkspaceContextStore(initialState, { disablePersistenceForStorybook }),
  );

  useEffect(() => {
    if (disablePersistenceForStorybook === true) {
      return;
    }
    const documents = getManagedDocumentStore();
    const persistedKeys = [
      "featureTours",
      "layoutBrowser",
      "playbackControls",
      "sidebars",
    ] as const;
    let previous = _.pick(store.getState(), persistedKeys);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Partial<WorkspaceContextStore> | undefined;
    let running = false;
    let closed = false;
    const hasPending = () => pending != undefined;
    const isClosed = () => closed;
    const flush = async () => {
      if (running || closed || !pending) {
        return;
      }
      const value = pending;
      pending = undefined;
      running = true;
      try {
        await documents.commit([{ family: "workspace", key: "ui", value }]);
      } catch (error: unknown) {
        console.error(error);
      } finally {
        running = false;
        if (hasPending() && !isClosed() && !documents.state.error) {
          void flush();
        }
      }
    };
    const unsubscribe = store.subscribe((state) => {
      const next = _.pick(state, persistedKeys);
      if (_.isEqual(previous, next)) {
        return;
      }
      previous = next;
      pending = next;
      timer ??= setTimeout(() => {
        timer = undefined;
        void flush();
      }, 250);
    });
    return () => {
      closed = true;
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [disablePersistenceForStorybook, store]);

  return <WorkspaceContext.Provider value={store}>{children}</WorkspaceContext.Provider>;
}
