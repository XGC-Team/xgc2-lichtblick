// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as _ from "lodash-es";
import { useCallback, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";

import { getManagedDocumentStore } from "@lichtblick/suite-base/services/persistence/ManagedPersistence";

type Common = { id: string; sourceId: string; title: string; label?: string };
type Connection = Common & { type: "connection"; extra?: Record<string, string | undefined> };
type LocalFile = Common & { type: "file"; handles: FileSystemFileHandle[] };
export type RecentRecord = Connection | LocalFile;
type RecentMetadata = Connection | Omit<LocalFile, "handles">;
type UnsavedRecent = Omit<Connection, "id"> | Omit<LocalFile, "id">;

export default function useManagedRecents(): {
  recents: RecentRecord[];
  addRecent: (record: UnsavedRecent) => void;
  save: () => Promise<void>;
} {
  const store = getManagedDocumentStore();
  const [recents, setRecents] = useState<RecentRecord[]>(() =>
    (store.get<RecentMetadata[]>("workspace", "recents") ?? []).map((record) =>
      record.type === "file" ? { ...record, handles: [] } : record,
    ),
  );
  const pending = useRef(recents);
  const generation = useRef(0);
  const saving = useRef<Promise<void> | undefined>(undefined);
  const save = useCallback(async () => {
    if (saving.current) {
      await saving.current;
      return;
    }
    const operation = (async () => {
      let savedGeneration: number;
      do {
        savedGeneration = generation.current;
        const selected: RecentRecord[] = [];
        for (const record of pending.current) {
          if (
            selected.some(
              (previous) =>
                previous.type === record.type &&
                previous.sourceId === record.sourceId &&
                (record.type === "file"
                  ? previous.title === record.title
                  : previous.type === "connection" && _.isEqual(previous.extra, record.extra)),
            )
          ) {
            continue;
          }
          selected.push(record);
          if (selected.length === 5) {
            break;
          }
        }
        const metadata: RecentMetadata[] = selected.map((record) => {
          if (record.type !== "file") {
            return record;
          }
          const { handles: _capability, ...identity } = record;
          return identity;
        });
        await store.commit([{ family: "workspace", key: "recents", value: metadata }]);
        setRecents(selected);
      } while (savedGeneration !== generation.current);
    })();
    saving.current = operation;
    try {
      await operation;
    } finally {
      saving.current = undefined;
    }
  }, [store]);
  const addRecent = useCallback(
    (record: UnsavedRecent) => {
      pending.current = [{ ...record, id: uuid() }, ...pending.current].slice(0, 10);
      generation.current++;
      void save().catch((error: unknown) => {
        console.error(error);
      });
    },
    [save],
  );
  return useMemo(() => ({ recents, addRecent, save }), [recents, addRecent, save]);
}
