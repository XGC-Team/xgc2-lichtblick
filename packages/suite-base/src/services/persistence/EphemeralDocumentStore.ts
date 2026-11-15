// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CORE_UI_DOCUMENT_BYTES, encodeCoreUiKey } from "./CoreUiDocumentClient";
import { CORE_UI_DOCUMENT_FAMILIES } from "./CoreUiDocumentStore";
import type { ManagedAssetReference, ManagedAssetTransport } from "./ManagedAsset";
import type {
  ManagedChange,
  ManagedCommitState,
  ManagedDocumentStorage,
  ManagedFamily,
  ManagedKey,
} from "./ManagedDocumentStore.types";
import { validateManagedLayout } from "./validateManagedLayout";

type CoreFamily = (typeof CORE_UI_DOCUMENT_FAMILIES)[number];
type RecordValue = ManagedKey & { value: unknown; version: string };

const GUEST_VIEWER_PREFIX = "/api/access/entry/viewer";

function identity(key: ManagedKey): string {
  return JSON.stringify([key.family, key.key])!;
}

function isGuestViewerPathname(pathname: string): boolean {
  return pathname === GUEST_VIEWER_PREFIX || pathname.startsWith(`${GUEST_VIEWER_PREFIX}/`);
}

/**
 * Share guests are mounted read-only under `/api/access/entry/viewer/` and must
 * not call operator `/api/ui-documents/lichtblick/*` endpoints.
 */
export function isEphemeralGuestViewerLocation(): boolean {
  const host = Reflect.get(globalThis, "window") as
    | { location?: { pathname?: unknown } }
    | undefined;
  const pathname = host?.location?.pathname;
  if (typeof pathname === "string") {
    return isGuestViewerPathname(pathname);
  }
  const doc = (globalThis as { document?: { baseURI?: unknown } }).document;
  const baseURI = doc?.baseURI;
  if (typeof baseURI === "string" && baseURI.length > 0) {
    try {
      return isGuestViewerPathname(new URL(baseURI).pathname);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Pure in-memory document store used by read-only Share Guest viewers so viewer
 * initialization and imported `layoutUrl` hydration succeed without hitting
 * operator Core UI document APIs.
 */
export class EphemeralDocumentStore implements ManagedDocumentStorage {
  #records = new Map<string, RecordValue>();
  #loaded = false;
  #nextRevision = 1;
  #listeners = new Set<() => void>();
  #state: ManagedCommitState = { pending: 0 };

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
    if (
      families.length === 0 ||
      new Set(families).size !== families.length ||
      families.some((family) => !CORE_UI_DOCUMENT_FAMILIES.includes(family as CoreFamily))
    ) {
      throw new Error("Invalid Core UI document families");
    }
    this.#records = new Map<string, RecordValue>();
    this.#loaded = true;
    this.#state = { pending: 0 };
    this.#notify();
  }

  #prepareChanges(
    input: readonly ManagedChange[] | (() => readonly ManagedChange[]),
  ): ManagedChange[] {
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
  }

  public async commit(
    input: readonly ManagedChange[] | (() => readonly ManagedChange[]),
  ): Promise<void> {
    this.#assertLoaded();
    const changes = this.#prepareChanges(input);
    for (const change of changes) {
      if (change.delete === true) {
        this.#records.delete(identity(change));
      } else {
        this.#records.set(identity(change), {
          family: change.family,
          key: change.key,
          value: structuredClone(change.value),
          version: String(this.#nextRevision++),
        });
      }
    }
    this.#notify();
  }
}

/** Rejects extension archive uploads/reads locally in read-only guest viewers. */
export class EphemeralAssetTransport implements ManagedAssetTransport {
  public async publish(): Promise<ManagedAssetReference> {
    throw new Error("Extension assets are unavailable in read-only guest viewer");
  }

  public async load(): Promise<Uint8Array> {
    throw new Error("Extension assets are unavailable in read-only guest viewer");
  }
}
