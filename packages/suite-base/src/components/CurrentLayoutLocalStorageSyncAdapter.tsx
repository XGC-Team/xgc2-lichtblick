// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import assert from "assert";
import { useCallback, useEffect, useRef } from "react";
import { useAsync } from "react-use";
import { useDebounce } from "use-debounce";

import Log from "@lichtblick/log";
import { LOCAL_STORAGE_STUDIO_LAYOUT_KEY } from "@lichtblick/suite-base/constants/browserStorageKeys";
import {
  LayoutData,
  LayoutID,
  LayoutState,
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";

export function selectLayoutData(state: LayoutState): LayoutData | undefined {
  return state.selectedLayout?.data;
}

export function selectLayoutId(state: LayoutState): LayoutID | undefined {
  return state.selectedLayout?.id;
}

const log = Log.getLogger(__filename);

export function CurrentLayoutLocalStorageSyncAdapter(): React.JSX.Element {
  const { getCurrentLayoutState } = useCurrentLayoutActions();
  const currentLayoutData = useCurrentLayoutSelector(selectLayoutData);
  const currentLayoutId = useCurrentLayoutSelector(selectLayoutId);

  const layoutManager = useLayoutManager();

  const [debouncedLayoutData] = useDebounce(currentLayoutData, 250, { maxWait: 500 });

  // Track if this is the initial layout load to prevent false "edited" states
  const isInitialLayoutLoad = useRef(true);

  // Reset the flag when layout changes
  useEffect(() => {
    isInitialLayoutLoad.current = true;
  }, [currentLayoutId]);

  // Serializing the whole layout is expensive and previously ran synchronously in this effect,
  // blocking the main thread on every layout change (e.g. each cameraMove config update during
  // a 3D camera drag). The write is deferred to an idle callback (with a timeout bound), and
  // pending data is flushed synchronously on beforeunload/unmount so a pending layout is never
  // lost when the page closes.
  const pendingLayoutDataRef = useRef<LayoutData | undefined>(undefined);

  const flushPendingLayoutToLocalStorage = useCallback(() => {
    const layoutData = pendingLayoutDataRef.current;
    if (layoutData == undefined) {
      return;
    }
    pendingLayoutDataRef.current = undefined;

    const serializedLayoutData = JSON.stringify(layoutData);
    assert(serializedLayoutData);
    localStorage.setItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, serializedLayoutData);
  }, []);

  useEffect(() => {
    if (!debouncedLayoutData) {
      return;
    }

    pendingLayoutDataRef.current = debouncedLayoutData;

    if (typeof window.requestIdleCallback === "function") {
      const idleHandle = window.requestIdleCallback(flushPendingLayoutToLocalStorage, {
        timeout: 1000,
      });
      return () => {
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(idleHandle);
        }
      };
    }

    const timeoutHandle = setTimeout(flushPendingLayoutToLocalStorage, 0);
    return () => {
      clearTimeout(timeoutHandle);
    };
  }, [debouncedLayoutData, flushPendingLayoutToLocalStorage]);

  useEffect(() => {
    window.addEventListener("beforeunload", flushPendingLayoutToLocalStorage);
    return () => {
      window.removeEventListener("beforeunload", flushPendingLayoutToLocalStorage);
      // Flush any write that was cancelled by the teardown of the scheduling effect above.
      flushPendingLayoutToLocalStorage();
    };
  }, [flushPendingLayoutToLocalStorage]);

  // Send new layoutData to layoutManager to be saved
  useAsync(async () => {
    const layoutState = getCurrentLayoutState();

    if (!layoutState.selectedLayout) {
      return;
    }

    // Skip updating layout manager during initial layout load to prevent
    // false "edited" states from panel initialization
    if (isInitialLayoutLoad.current) {
      isInitialLayoutLoad.current = false;
      return;
    }

    try {
      // We only update the layout data (panels configuration) here, not the name.
      // Name changes are handled separately via layoutManager.updateLayout in rename operations.
      // This ensures that data modifications are saved to the 'working' copy in IDB,
      // allowing users to see the orange dot indicator for unsaved changes.
      await layoutManager.updateLayout({
        id: layoutState.selectedLayout.id,
        data: debouncedLayoutData,
      });
    } catch (error) {
      log.error(error);
    }
  }, [debouncedLayoutData, getCurrentLayoutState, layoutManager]);

  return <></>;
}
