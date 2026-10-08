// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import { useDebounce } from "use-debounce";

import {
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import type { Layout } from "@lichtblick/suite-base/services/ILayoutStorage";
import { isLayoutEqual } from "@lichtblick/suite-base/services/LayoutManager/utils/isLayoutEqual";
import {
  getManagedDocumentStore,
  reloadManagedApplication,
} from "@lichtblick/suite-base/services/persistence/ManagedPersistence";

export function CurrentLayoutManagedSyncAdapter(): React.JSX.Element {
  const current = useCurrentLayoutSelector((state) => state.selectedLayout);
  const [debounced] = useDebounce(current, 250, { maxWait: 500 });
  const { getCurrentLayoutState } = useCurrentLayoutActions();
  const manager = useLayoutManager();
  const store = getManagedDocumentStore();
  const [state, setState] = useState(store.state);
  const mounted = useRef(true);
  const running = useRef(false);
  const pending = useRef(new Map<string, NonNullable<typeof current>>());
  const previous = useRef(current);
  useEffect(() => {
    mounted.current = true;
    const drafts = pending.current;
    return () => {
      mounted.current = false;
      drafts.clear();
    };
  }, []);
  useEffect(
    () =>
      store.subscribe(() => {
        setState(store.state);
      }),
    [store],
  );
  const save = useCallback(async () => {
    if (running.current) {
      return;
    }
    running.current = true;
    const isActive = () => mounted.current;
    try {
      while (pending.current.size > 0 && isActive()) {
        const selected = pending.current.values().next().value!;
        pending.current.delete(selected.id);
        if (!selected.data) {
          continue;
        }
        const layout = await manager.getLayout(selected.id);
        if (!isActive()) {
          break;
        }
        if (!layout || isLayoutEqual(layout.working?.data ?? layout.baseline.data, selected.data)) {
          continue;
        }
        await manager.updateLayout({ id: selected.id, data: selected.data });
      }
    } catch (error) {
      pending.current.clear();
      manager.setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running.current = false;
    }
  }, [manager]);
  useEffect(() => {
    const last = previous.current;
    previous.current = current;
    if (last?.data && last.id !== current?.id) {
      pending.current.set(last.id, last);
      void save();
    }
  }, [current, save]);
  useEffect(() => {
    if (debounced?.data && getCurrentLayoutState().selectedLayout?.id === debounced.id) {
      pending.current.set(debounced.id, debounced);
    }
    void save();
  }, [debounced, getCurrentLayoutState, save]);
  const unsubmitted = current?.data != undefined && current !== debounced;
  const saved = store
    .records<Layout>("layouts")
    .find(({ value }) => value.id === current?.id)?.value;
  const dirty =
    current?.data != undefined &&
    (!saved || !isLayoutEqual(saved.working?.data ?? saved.baseline.data, current.data));
  useEffect(() => {
    if (!dirty && !unsubmitted && state.pending === 0 && !state.error) {
      return;
    }
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      window.removeEventListener("beforeunload", guard);
    };
  }, [dirty, unsubmitted, state.pending, state.error]);
  const recover = async () => {
    if (state.uncertainRequestId) {
      await store.resolveReceipt();
    } else {
      reloadManagedApplication();
      return;
    }
    manager.setError(undefined);
  };
  return state.error ? (
    <div role="alert">
      Changes could not be saved: {state.error.message}
      <button
        disabled={state.pending > 0}
        onClick={() => {
          void recover().catch((error: unknown) => {
            console.error(error);
          });
        }}
      >
        {state.uncertainRequestId ? "Check save result" : "Reload saved state"}
      </button>
    </div>
  ) : state.pending > 0 || unsubmitted ? (
    <div role="status">Saving changes…</div>
  ) : dirty ? (
    <div role="status">Changes are not saved</div>
  ) : (
    <></>
  );
}
