// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LayoutID } from "../../context/CurrentLayoutContext";
import { UserProfile } from "../../context/UserProfileStorageContext";
import { ILayoutStorage, Layout, LayoutPutOptions } from "../ILayoutStorage";
import { ManagedChange, ManagedDocumentStore } from "./ManagedDocumentStore";
import { getManagedDocumentStore } from "./ManagedPersistence";

export function managedLayoutKey(namespace: string, id: LayoutID): string {
  return JSON.stringify([namespace, id])!;
}
export class ManagedLayoutStorage implements ILayoutStorage {
  public constructor(private store: ManagedDocumentStore = getManagedDocumentStore()) {}
  public async list(namespace: string): Promise<readonly Layout[]> {
    return this.#list(namespace);
  }
  #list(namespace: string): readonly Layout[] {
    return this.store
      .records<Layout>("layouts")
      .filter(({ key }) => {
        const identity: unknown = JSON.parse(key);
        return Array.isArray(identity) && identity.length === 2 && identity[0] === namespace;
      })
      .map(({ value }) => value);
  }
  public async get(namespace: string, id: LayoutID): Promise<Layout | undefined> {
    return this.store.get<Layout>("layouts", managedLayoutKey(namespace, id));
  }
  public async put(namespace: string, layout: Layout, options?: LayoutPutOptions): Promise<Layout> {
    await this.putLayouts(namespace, [layout], options);
    return layout;
  }
  public async putLayouts(
    namespace: string,
    layouts: readonly Layout[],
    options?: LayoutPutOptions,
  ): Promise<readonly Layout[]> {
    if (layouts.length === 0) {
      throw new Error("Layout import requires a layout");
    }
    await this.store.commit(() => {
      const previousProfile = this.store.get<UserProfile>("profile", "user") ?? {};
      const profile =
        options?.activate === true
          ? { ...previousProfile, currentLayoutId: layouts.at(-1)!.id }
          : previousProfile;
      const changes: ManagedChange[] = [
        ...layouts.map(
          (layout): ManagedChange => ({
            family: "layouts",
            key: managedLayoutKey(namespace, layout.id),
            value: layout,
          }),
        ),
        { family: "profile", key: "user", value: profile },
        ...[...new Set(options?.replaceIds ?? [])]
          .filter((id) => !layouts.some((layout) => layout.id === id))
          .map(
            (id): ManagedChange => ({
              family: "layouts",
              key: managedLayoutKey(namespace, id),
              delete: true,
            }),
          ),
      ];
      return changes;
    });
    return layouts;
  }
  public async delete(namespace: string, id: LayoutID): Promise<void> {
    await this.store.commit(() => {
      const profile = this.store.get<UserProfile>("profile", "user") ?? {};
      const changes: ManagedChange[] = [
        { family: "layouts", key: managedLayoutKey(namespace, id), delete: true },
      ];
      if (profile.currentLayoutId === id) {
        const { currentLayoutId: _removed, ...next } = profile;
        changes.push({ family: "profile", key: "user", value: next });
      }
      return changes;
    });
  }
  public async importLayouts({
    fromNamespace,
    toNamespace,
  }: {
    fromNamespace: string;
    toNamespace: string;
  }): Promise<void> {
    if (fromNamespace === toNamespace) {
      throw new Error("Layout import namespaces must differ");
    }
    if (this.#list(fromNamespace).length === 0) {
      return;
    }
    await this.store.commit(() => {
      const source = this.#list(fromNamespace);
      const target = this.#list(toNamespace);
      const names = new Map(target.map((layout) => [layout.name, layout]));
      const identities = new Set(target.map((layout) => layout.id));
      const changes: ManagedChange[] = [];
      const profile = this.store.get<UserProfile>("profile", "user") ?? {};
      let nextProfile = profile;
      for (const layout of source) {
        const duplicate = names.get(layout.name);
        if (!duplicate) {
          if (identities.has(layout.id)) {
            throw new Error("Layout namespace import identity conflict");
          }
          changes.push({
            family: "layouts",
            key: managedLayoutKey(toNamespace, layout.id),
            value: layout,
          });
          names.set(layout.name, layout);
        }
        changes.push({
          family: "layouts",
          key: managedLayoutKey(fromNamespace, layout.id),
          delete: true,
        });
        if (profile.currentLayoutId === layout.id && duplicate) {
          nextProfile = { ...nextProfile, currentLayoutId: duplicate.id };
        }
      }
      changes.push({ family: "profile", key: "user", value: nextProfile });
      return changes;
    });
  }
}
