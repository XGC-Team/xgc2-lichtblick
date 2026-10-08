// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as _ from "lodash-es";
import { useCallback, useMemo } from "react";

import {
  UserProfile,
  UserProfileStorageContext,
} from "@lichtblick/suite-base/context/UserProfileStorageContext";
import { getManagedDocumentStore } from "@lichtblick/suite-base/services/persistence/ManagedPersistence";

export default function ManagedUserProfileProvider({
  children,
}: React.PropsWithChildren): React.JSX.Element {
  const store = getManagedDocumentStore();
  const getUserProfile = useCallback(
    async () => store.get<UserProfile>("profile", "user") ?? {},
    [store],
  );
  const setUserProfile = useCallback(
    async (value: UserProfile | ((prev: UserProfile) => UserProfile)) => {
      const observed = store.get<UserProfile>("profile", "user") ?? {};
      if (
        typeof value !== "function" &&
        _.isEqual(observed, { ...observed, ...value }) &&
        store.state.pending === 0
      ) {
        return;
      }
      await store.commit(() => {
        const previous = store.get<UserProfile>("profile", "user") ?? {};
        const next = typeof value === "function" ? value(previous) : { ...previous, ...value };
        const layout = next.currentLayoutId
          ? store
              .records<unknown>("layouts")
              .find(({ value: data }) => (data as { id?: string }).id === next.currentLayoutId)
          : undefined;
        if (next.currentLayoutId && !layout) {
          throw new Error("Selected managed layout does not exist");
        }
        return [
          { family: "profile", key: "user", value: next },
          ...(layout ? [{ family: "layouts" as const, key: layout.key, value: layout.value }] : []),
        ];
      });
    },
    [store],
  );
  const storage = useMemo(
    () => ({ getUserProfile, setUserProfile }),
    [getUserProfile, setUserProfile],
  );
  return (
    <UserProfileStorageContext.Provider value={storage}>
      {children}
    </UserProfileStorageContext.Provider>
  );
}
