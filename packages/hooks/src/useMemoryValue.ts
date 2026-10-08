// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { useCallback, useSyncExternalStore } from "react";

const values = new Map<string, string>();
const listeners = new Set<() => void>();
/** A temporary launch intention shared by components in this application session. */
export function useMemoryValue(
  key: string,
): [string | undefined, (value: string | undefined) => void] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const snapshot = useCallback(() => values.get(key), [key]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setValue = useCallback(
    (next: string | undefined) => {
      if (next != undefined && (next.length > 512 || (!values.has(key) && values.size >= 64))) {
        throw new Error("Temporary preference limit exceeded");
      }
      if (next == undefined) {
        values.delete(key);
      } else {
        values.set(key, next);
      }
      for (const listener of listeners) {
        listener();
      }
    },
    [key],
  );
  return [value, setValue];
}
