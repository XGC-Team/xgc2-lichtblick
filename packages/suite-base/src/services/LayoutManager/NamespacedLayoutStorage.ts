// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LayoutID } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import {
  ILayoutStorage,
  Layout,
  LayoutPutOptions,
} from "@lichtblick/suite-base/services/ILayoutStorage";

export class NamespacedLayoutStorage {
  #import: Promise<void>;
  public constructor(
    private storage: ILayoutStorage,
    private namespace: string,
    { importFromNamespace }: { importFromNamespace: string | undefined },
  ) {
    this.#import =
      importFromNamespace == undefined
        ? Promise.resolve()
        : storage.importLayouts({ fromNamespace: importFromNamespace, toNamespace: namespace });
  }
  public async list(): Promise<readonly Layout[]> {
    await this.#import;
    return await this.storage.list(this.namespace);
  }
  public async get(id: LayoutID): Promise<Layout | undefined> {
    await this.#import;
    return await this.storage.get(this.namespace, id);
  }
  public async put(layout: Layout, options?: LayoutPutOptions): Promise<Layout> {
    await this.#import;
    return await this.storage.put(
      this.namespace,
      layout,
      ...(options == undefined ? [] : [options]),
    );
  }
  public async delete(id: LayoutID): Promise<void> {
    await this.#import;
    await this.storage.delete(this.namespace, id);
  }
  public async putLayouts(
    layouts: readonly Layout[],
    options?: LayoutPutOptions,
  ): Promise<readonly Layout[]> {
    await this.#import;
    if (!this.storage.putLayouts) {
      throw new Error("Atomic layout import is not available");
    }
    return await this.storage.putLayouts(this.namespace, layouts, options);
  }
}
