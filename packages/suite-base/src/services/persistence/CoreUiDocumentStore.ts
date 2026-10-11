// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  CORE_UI_DOCUMENT_BYTES,
  CoreUiDocumentClient,
  encodeCoreUiKey,
} from "./CoreUiDocumentClient";
import type {
  ManagedChange,
  ManagedCommitState,
  ManagedDocumentStorage,
  ManagedFamily,
  ManagedKey,
} from "./ManagedDocumentStore.types";
import { ManagedRequestError } from "./ManagedDocumentStore.types";
import { validateManagedLayout } from "./validateManagedLayout";

export const CORE_UI_DOCUMENT_FAMILIES = [
  "layouts",
  "profile",
  "configuration",
  "workspace",
  "extensions",
] as const;
type CoreFamily = (typeof CORE_UI_DOCUMENT_FAMILIES)[number];
type RecordValue = ManagedKey & { value: unknown; version: string };

function identity(key: ManagedKey): string {
  return JSON.stringify([key.family, key.key])!;
}

/**
 * Core has per-document CAS, not an atomic batch or a snapshot spanning list pages.
 * A batch writes in order and keeps each acknowledged result. The first failure
 * stops the batch, rereads its documents (also covering a lost write response),
 * refuses queued edits and rejects the caller. Earlier writes are never silently
 * rolled back, and a partially completed batch is never reported as successful.
 * Consumers must await commit before reporting success; on conflict the web
 * initializer reloads the application after recovery. Reload clears the error.
 */
export class CoreUiDocumentStore implements ManagedDocumentStorage {
  #records = new Map<string, RecordValue>();
  #loaded = false;
  #tail: Promise<unknown> = Promise.resolve();
  #listeners = new Set<() => void>();
  #state: ManagedCommitState = { pending: 0 };

  public constructor(private client = new CoreUiDocumentClient()) {}

  // eslint-disable-next-line no-restricted-syntax -- A stable snapshot for external-store subscribers.
  public get state(): ManagedCommitState {
    return this.#state;
  }

  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #assertLoaded(): void {
    if (!this.#loaded) {
      throw new Error("Managed persistence has not loaded");
    }
  }

  public get<T>(family: ManagedFamily, key: string): T | undefined {
    this.#assertLoaded();
    return structuredClone(this.#records.get(identity({ family, key }))?.value) as T | undefined;
  }

  public records<T>(family: ManagedFamily): readonly { key: string; value: T; version: string }[] {
    this.#assertLoaded();
    return [...this.#records.values()]
      .filter((record) => record.family === family)
      .map(({ key, value, version }) => ({ key, value: structuredClone(value) as T, version }));
  }

  public async bootstrap(
    families: readonly ManagedFamily[] = CORE_UI_DOCUMENT_FAMILIES,
  ): Promise<void> {
    if (this.#state.pending > 0) {
      throw new Error("Cannot reload pending managed edits");
    }
    if (
      families.length === 0 ||
      new Set(families).size !== families.length ||
      families.some((family) => !CORE_UI_DOCUMENT_FAMILIES.includes(family as CoreFamily))
    ) {
      throw new Error("Invalid Core UI document families");
    }
    const records = new Map<string, RecordValue>();
    for (const family of families) {
      let after = "";
      const cursors = new Set<string>();
      for (;;) {
        const page = await this.client.list(family, after);
        for (const item of page.items) {
          const record = {
            family,
            key: item.body.key,
            value: item.body.value,
            version: item.revision,
          };
          if (records.has(identity(record))) {
            throw new Error("Duplicate Core UI document");
          }
          if (family === "layouts") {
            validateManagedLayout(record.value);
          }
          records.set(identity(record), structuredClone(record));
        }
        if (records.size > 1024) {
          throw new Error("Core UI document count limit exceeded");
        }
        if (page.next === "") {
          break;
        }
        if (
          page.items.length === 0 ||
          cursors.has(page.next) ||
          page.next !== page.items.at(-1)?.id
        ) {
          throw new Error("Invalid or repeated Core UI document cursor");
        }
        cursors.add(page.next);
        after = page.next;
      }
    }
    this.#records = records;
    this.#loaded = true;
    this.#state = { pending: 0 };
    this.#notify();
  }

  #prepareChanges(
    input: readonly ManagedChange[] | (() => readonly ManagedChange[]),
  ): ManagedChange[] {
    try {
      const inputChanges = typeof input === "function" ? input() : input;
      if (inputChanges.length === 0 || inputChanges.length > 256) {
        throw new Error("Managed batch must contain 1–256 changes");
      }
      const changes = JSON.parse(JSON.stringify(inputChanges)!) as ManagedChange[];
      const unique = new Set<string>();
      for (const change of changes) {
        if (
          !CORE_UI_DOCUMENT_FAMILIES.includes(change.family as CoreFamily) ||
          typeof change.key !== "string" ||
          change.key === "" ||
          unique.has(identity(change)) ||
          (change.delete !== true && !("value" in change)) ||
          (change.delete === true && "value" in change)
        ) {
          throw new Error("Invalid managed batch change");
        }
        encodeCoreUiKey(change.key);
        unique.add(identity(change));
        if (change.delete === true) {
          continue;
        }
        if (change.family === "layouts") {
          validateManagedLayout(change.value);
        }
        const limit =
          change.family === "layouts"
            ? CORE_UI_DOCUMENT_BYTES
            : change.family === "extensions"
              ? 256 * 1024
              : 64 * 1024;
        const valueBytes = new TextEncoder().encode(JSON.stringify(change.value)).length;
        const bodyBytes = new TextEncoder().encode(
          JSON.stringify({ key: change.key, value: change.value }),
        ).length;
        if (valueBytes > limit || bodyBytes > CORE_UI_DOCUMENT_BYTES) {
          throw new Error("Managed document size limit exceeded");
        }
      }
      return changes;
    } catch (error) {
      throw new ManagedValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  async #recover(changes: readonly ManagedChange[]): Promise<Error | undefined> {
    let failure: Error | undefined;
    for (const change of changes) {
      try {
        const current = await this.client.get(change.family, change.key);
        if (current) {
          if (change.family === "layouts") {
            validateManagedLayout(current.body.value);
          }
          this.#records.set(identity(change), {
            family: change.family,
            key: current.body.key,
            value: structuredClone(current.body.value),
            version: current.revision,
          });
        } else {
          this.#records.delete(identity(change));
        }
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    return failure;
  }

  public async commit(
    input: readonly ManagedChange[] | (() => readonly ManagedChange[]),
  ): Promise<void> {
    this.#assertLoaded();
    if (this.#state.error) {
      throw this.#state.error;
    }
    if (this.#state.pending >= 32) {
      throw new Error("Managed save queue is full");
    }
    const prepared = typeof input === "function" ? undefined : this.#prepareChanges(input);
    this.#state = { ...this.#state, pending: this.#state.pending + 1 };
    this.#notify();
    const job = this.#tail.then(async () => {
      if (this.#state.error) {
        throw this.#state.error;
      }
      const changes = prepared ?? this.#prepareChanges(input);
      try {
        for (const change of changes) {
          const expectedRevision = this.#records.get(identity(change))?.version ?? "0";
          if (change.delete === true) {
            await this.client.delete(change.family, change.key, expectedRevision);
            this.#records.delete(identity(change));
          } else {
            const result = await this.client.put(
              change.family,
              change.key,
              change.value,
              expectedRevision,
            );
            this.#records.set(identity(change), {
              family: change.family,
              key: change.key,
              value: structuredClone(change.value),
              version: result.revision,
            });
          }
        }
      } catch (error) {
        let failure = error instanceof Error ? error : new Error(String(error));
        this.#state = { ...this.#state, error: failure };
        const recoveryError = await this.#recover(changes);
        if (recoveryError) {
          const message = `${failure.message}; document reload failed: ${recoveryError.message}`;
          failure =
            failure instanceof ManagedRequestError
              ? new ManagedRequestError(message, failure.code)
              : new Error(message);
          this.#state = { ...this.#state, error: failure };
        }
        throw failure;
      }
    });
    this.#tail = job.catch(() => undefined);
    try {
      await job;
    } finally {
      this.#state = { ...this.#state, pending: this.#state.pending - 1 };
      this.#notify();
    }
  }
}

class ManagedValidationError extends Error {}
