// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { ManagedDocumentStore } from "./ManagedDocumentStore";
import { getManagedDocumentStore } from "./ManagedPersistence";
import {
  AppConfigurationValue,
  ChangeHandler,
  IAppConfiguration,
} from "../../context/AppConfigurationContext";

export class ManagedAppConfiguration implements IAppConfiguration {
  #listeners = new Map<string, Set<ChangeHandler>>();
  #observed = new Map<string, AppConfigurationValue>();
  public constructor(
    private store: ManagedDocumentStore = getManagedDocumentStore(),
    private defaults: Record<string, AppConfigurationValue> = {},
  ) {
    store.subscribe(() => {
      for (const [key, listeners] of this.#listeners) {
        const value = this.get(key);
        if (value !== this.#observed.get(key)) {
          this.#observed.set(key, value);
          for (const listener of listeners) {
            listener(value);
          }
        }
      }
    });
  }
  public get(key: string): AppConfigurationValue {
    return this.store.get<AppConfigurationValue>("configuration", key) ?? this.defaults[key];
  }
  public async set(key: string, value: AppConfigurationValue): Promise<void> {
    await this.store.commit([
      { family: "configuration", key, ...(value == undefined ? { delete: true } : { value }) },
    ]);
  }
  public addChangeListener(key: string, listener: ChangeHandler): void {
    const listeners = this.#listeners.get(key) ?? new Set<ChangeHandler>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    if (!this.#observed.has(key)) {
      this.#observed.set(key, this.get(key));
    }
  }
  public removeChangeListener(key: string, listener: ChangeHandler): void {
    this.#listeners.get(key)?.delete(listener);
    if (this.#listeners.get(key)?.size === 0) {
      this.#listeners.delete(key);
      this.#observed.delete(key);
    }
  }
}
