// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { validateManagedLayout } from "./validateManagedLayout";

export const MANAGED_FAMILIES = [
  "layouts",
  "profile",
  "configuration",
  "workspace",
  "extensions",
  "desktop",
] as const;
export type ManagedFamily = (typeof MANAGED_FAMILIES)[number];
export type ManagedToken = { database_id: string; schema: string; revision: string };
export type ManagedKey = { family: ManagedFamily; key: string };
export type ManagedRecord = ManagedKey & {
  version: string;
  value?: unknown;
  missing?: boolean;
  deleted?: boolean;
};
export type ManagedChange = ManagedKey & { value?: unknown; delete?: boolean };
export type ManagedBatchReceipt = {
  token: ManagedToken;
  requestId: string;
  durability: "sqlite-full";
  versions: (ManagedKey & { version: string })[];
};
export type ManagedRequest =
  | { operation: "snapshot"; keys: ManagedKey[]; at?: ManagedToken }
  | {
      operation: "snapshot";
      families: readonly ManagedFamily[];
      after?: string;
      limit?: number;
      at?: ManagedToken;
    }
  | {
      operation: "batch";
      expected: ManagedToken;
      requestId: string;
      changes: (ManagedChange & { expectedVersion: string })[];
    }
  | { operation: "receipt"; requestId: string };
export type ManagedTransport = (request: ManagedRequest) => Promise<unknown>;
export type ManagedCommitState = { pending: number; error?: Error; uncertainRequestId?: string };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}
function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}
function token(value: unknown): value is ManagedToken {
  return (
    object(value) &&
    typeof value.database_id === "string" &&
    value.database_id.length > 0 &&
    typeof value.schema === "string" &&
    value.schema.length > 0 &&
    decimal(value.revision)
  );
}
function sameToken(first: ManagedToken, second: ManagedToken): boolean {
  return (
    first.database_id === second.database_id &&
    first.schema === second.schema &&
    first.revision === second.revision
  );
}
function identity(key: ManagedKey): string {
  return JSON.stringify([key.family, key.key])!;
}
function validateKey(value: unknown): asserts value is ManagedKey {
  if (
    !object(value) ||
    !MANAGED_FAMILIES.includes(value.family as ManagedFamily) ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    new TextEncoder().encode(value.key).length > 480
  ) {
    throw new Error("Invalid managed document identity");
  }
}
function bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized == undefined) {
    throw new Error("Managed documents must be JSON values");
  }
  return new TextEncoder().encode(serialized).length;
}

/** One loaded, fenced snapshot. Memory changes only after a durable receipt. */
export class ManagedDocumentStore {
  #transport: ManagedTransport;
  #token: ManagedToken | undefined;
  #records = new Map<string, ManagedRecord>();
  #tail: Promise<unknown> = Promise.resolve();
  #listeners = new Set<() => void>();
  #state: ManagedCommitState = { pending: 0 };
  #uncertain: { requestId: string; changes: ManagedChange[] } | undefined;

  public constructor(transport: ManagedTransport) {
    this.#transport = transport;
  }
  // eslint-disable-next-line no-restricted-syntax -- A stable snapshot for external-store subscribers.
  public get state(): ManagedCommitState {
    return this.#state;
  }
  // eslint-disable-next-line no-restricted-syntax -- Access through a function boundary preserves async narrowing.
  public get uncertainRequestId(): string | undefined {
    return this.#uncertain?.requestId;
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
  #loaded(): ManagedToken {
    if (!this.#token) {
      throw new Error("Managed persistence has not loaded");
    }
    return this.#token;
  }
  public get<T>(family: ManagedFamily, key: string): T | undefined {
    this.#loaded();
    const record = this.#records.get(identity({ family, key }));
    return record?.missing === true || record?.deleted === true
      ? undefined
      : (structuredClone(record?.value) as T | undefined);
  }
  public records<T>(family: ManagedFamily): readonly { key: string; value: T; version: string }[] {
    this.#loaded();
    return [...this.#records.values()]
      .filter(
        (record) => record.family === family && record.deleted !== true && record.missing !== true,
      )
      .map((record) => ({
        key: record.key,
        value: structuredClone(record.value) as T,
        version: record.version,
      }));
  }
  #parseSnapshot(response: unknown): {
    token: ManagedToken;
    records: ManagedRecord[];
    nextAfter?: string;
  } {
    if (
      !object(response) ||
      !token(response.token) ||
      !Array.isArray(response.records) ||
      response.records.length > 2048 ||
      (response.nextAfter != undefined && typeof response.nextAfter !== "string") ||
      bytes(response) > 4 * 1024 * 1024
    ) {
      throw new Error("Invalid managed snapshot");
    }
    for (const record of response.records) {
      validateKey(record);
      if (!decimal((record as ManagedRecord).version)) {
        throw new Error("Invalid managed document version");
      }
      if (
        record.family === "layouts" &&
        (record as ManagedRecord).missing !== true &&
        (record as ManagedRecord).deleted !== true
      ) {
        validateManagedLayout((record as ManagedRecord).value);
      }
    }
    return response as { token: ManagedToken; records: ManagedRecord[]; nextAfter?: string };
  }
  public async bootstrap(families: readonly ManagedFamily[] = MANAGED_FAMILIES): Promise<void> {
    if (this.#state.pending > 0 || this.#uncertain) {
      throw new Error("Cannot reload pending managed edits");
    }
    if (
      families.length === 0 ||
      new Set(families).size !== families.length ||
      families.some((family) => !MANAGED_FAMILIES.includes(family))
    ) {
      throw new Error("Invalid managed snapshot families");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#bootstrapSnapshot(families);
        return;
      } catch (error) {
        if (!(error instanceof ManagedRequestError) || error.code !== "conflict" || attempt === 2) {
          throw error;
        }
      }
    }
  }
  async #bootstrapSnapshot(families: readonly ManagedFamily[]): Promise<void> {
    const records = new Map<string, ManagedRecord>();
    let at: ManagedToken | undefined;
    for (const family of families) {
      let after: string | undefined;
      const cursors = new Set<string>();
      let complete = false;
      let limit = 128;
      for (let page = 0; page < 4104; page++) {
        let response;
        try {
          response = this.#parseSnapshot(
            await this.#transport({ operation: "snapshot", families: [family], at, after, limit }),
          );
        } catch (error) {
          if (
            error instanceof ManagedRequestError &&
            error.code === "resource_exhausted" &&
            limit > 1
          ) {
            limit = Math.max(1, Math.floor(limit / 2));
            continue;
          }
          throw error;
        }
        if (at && !sameToken(at, response.token)) {
          throw new ManagedRequestError("Managed snapshot changed between pages", "conflict");
        }
        at = response.token;
        for (const record of response.records) {
          const id = identity(record);
          if (record.family !== family || records.has(id)) {
            throw new Error("Duplicate or unexpected managed snapshot record");
          }
          records.set(id, structuredClone(record));
        }
        if (records.size > 4096) {
          throw new Error("Managed snapshot record limit exceeded");
        }
        if (!response.nextAfter) {
          complete = true;
          break;
        }
        if (cursors.has(response.nextAfter)) {
          throw new Error("Managed snapshot cursor repeated");
        }
        cursors.add(response.nextAfter);
        after = response.nextAfter;
      }
      if (!complete) {
        throw new Error("Managed snapshot page limit exceeded");
      }
    }
    if (!at) {
      throw new Error("Managed snapshot requires a family");
    }
    this.#records = records;
    this.#token = at;
    this.#state = { pending: 0 };
    this.#notify();
  }
  #parseReceipt(value: unknown, requestId: string, changes: ManagedChange[]): ManagedBatchReceipt {
    if (
      !object(value) ||
      !token(value.token) ||
      value.requestId !== requestId ||
      value.durability !== "sqlite-full" ||
      !Array.isArray(value.versions) ||
      value.versions.length !== changes.length
    ) {
      throw new Error("Invalid durable managed receipt");
    }
    const expected = this.#loaded();
    if (
      value.token.database_id !== expected.database_id ||
      value.token.schema !== expected.schema ||
      BigInt(value.token.revision) <= BigInt(expected.revision)
    ) {
      throw new Error("Managed receipt fencing mismatch");
    }
    const ids = new Set(changes.map(identity));
    for (const version of value.versions) {
      validateKey(version);
      if (
        !decimal((version as ManagedRecord).version) ||
        (version as ManagedRecord).version !== value.token.revision ||
        !ids.delete(identity(version))
      ) {
        throw new Error("Invalid managed receipt versions");
      }
    }
    return value as ManagedBatchReceipt;
  }
  #apply(receipt: ManagedBatchReceipt, changes: ManagedChange[]): void {
    for (const change of changes) {
      const version = receipt.versions.find((item) => identity(item) === identity(change))!.version;
      this.#records.set(identity(change), {
        family: change.family,
        key: change.key,
        version,
        ...(change.delete === true ? { deleted: true } : { value: structuredClone(change.value) }),
      });
    }
    this.#token = structuredClone(receipt.token);
  }
  #prepareChanges(
    input: readonly ManagedChange[] | (() => readonly ManagedChange[]),
  ): ManagedChange[] {
    try {
      const values = typeof input === "function" ? input() : input;
      if (values.length === 0 || values.length > 256) {
        throw new Error("Managed batch must contain 1–256 changes");
      }
      const changes = JSON.parse(JSON.stringify(values)!) as ManagedChange[];
      const unique = new Set<string>();
      for (const change of changes) {
        validateKey(change);
        if (
          unique.has(identity(change)) ||
          (change.delete !== true && !("value" in change)) ||
          (change.delete === true && "value" in change)
        ) {
          throw new Error("Invalid managed batch change");
        }
        unique.add(identity(change));
        const limit =
          change.family === "layouts"
            ? 2 * 1024 * 1024
            : change.family === "extensions"
              ? 256 * 1024
              : 64 * 1024;
        if (change.family === "layouts" && change.delete !== true) {
          validateManagedLayout(change.value);
        }
        if (change.delete !== true && bytes(change.value) > limit) {
          throw new Error("Managed document size limit exceeded");
        }
      }
      return changes;
    } catch (error) {
      throw new ManagedValidationError(error instanceof Error ? error.message : String(error));
    }
  }
  public async commit(
    input: readonly ManagedChange[] | (() => readonly ManagedChange[]),
  ): Promise<ManagedBatchReceipt> {
    this.#loaded();
    if (this.#uncertain || this.#state.error) {
      throw this.#state.error ?? new Error("Resolve the uncertain managed commit before editing");
    }
    if (this.#state.pending >= 32) {
      throw new Error("Managed save queue is full");
    }
    const prepared = typeof input === "function" ? undefined : this.#prepareChanges(input);
    this.#state = { ...this.#state, pending: this.#state.pending + 1 };
    this.#notify();
    const job = this.#tail.then(async () => {
      if (this.#state.error || this.#uncertain) {
        throw this.#state.error ?? new Error("Managed commit is uncertain");
      }
      const changes = prepared ?? this.#prepareChanges(input);
      const expected = this.#loaded();
      const absent = changes
        .filter((change) => !this.#records.has(identity(change)))
        .map(({ family, key }) => ({ family, key }));
      for (let offset = 0; offset < absent.length; offset += 64) {
        const keys = absent.slice(offset, offset + 64);
        const response = this.#parseSnapshot(
          await this.#transport({ operation: "snapshot", keys, at: expected }),
        );
        if (!sameToken(expected, response.token) || response.records.length !== keys.length) {
          throw new Error("Managed key snapshot mismatch");
        }
        const requested = new Set(keys.map(identity));
        for (const record of response.records) {
          if (!requested.delete(identity(record))) {
            throw new Error("Unexpected managed snapshot key");
          }
          this.#records.set(identity(record), structuredClone(record));
        }
      }
      const requestId = crypto.randomUUID();
      const request: ManagedRequest = {
        operation: "batch",
        expected,
        requestId,
        changes: changes.map((change) => ({
          ...change,
          expectedVersion: this.#records.get(identity(change))?.version ?? "0",
        })),
      };
      if (bytes(request) > 4 * 1024 * 1024) {
        throw new Error("Managed request size limit exceeded");
      }
      let response: unknown;
      try {
        response = await this.#transport(request);
      } catch (error) {
        const definite =
          error instanceof ManagedRequestError &&
          (error.outcome === "not_sent" || error.outcome === "application_rejected");
        if (!definite) {
          this.#uncertain = { requestId, changes };
        }
        throw error;
      }
      let receipt: ManagedBatchReceipt;
      try {
        receipt = this.#parseReceipt(response, requestId, changes);
      } catch (error) {
        this.#uncertain = { requestId, changes };
        throw error;
      }
      this.#apply(receipt, changes);
      return receipt;
    });
    this.#tail = job.catch(() => undefined);
    try {
      return await job;
    } catch (error) {
      if (!(error instanceof ManagedValidationError)) {
        this.#state = {
          ...this.#state,
          error: error instanceof Error ? error : new Error(String(error)),
          uncertainRequestId: this.uncertainRequestId,
        };
      }
      throw error;
    } finally {
      this.#state = { ...this.#state, pending: this.#state.pending - 1 };
      this.#notify();
    }
  }
  public async resolveReceipt(): Promise<ManagedBatchReceipt> {
    const pending = this.#uncertain;
    if (!pending) {
      throw new Error("No uncertain managed request");
    }
    const receipt = this.#parseReceipt(
      await this.#transport({ operation: "receipt", requestId: pending.requestId }),
      pending.requestId,
      pending.changes,
    );
    this.#apply(receipt, pending.changes);
    this.#uncertain = undefined;
    this.#state = { pending: this.#state.pending };
    this.#notify();
    return receipt;
  }
}

export class ManagedRequestError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly outcome?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "ManagedRequestError";
  }
}

class ManagedValidationError extends Error {}
