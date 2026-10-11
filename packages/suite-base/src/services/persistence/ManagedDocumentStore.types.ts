// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** The consumer interface shared by Core's web store and the desktop IPC store. */
export type ManagedFamily =
  | "layouts"
  | "profile"
  | "configuration"
  | "workspace"
  | "extensions"
  | "desktop";
export type ManagedKey = { family: ManagedFamily; key: string };
export type ManagedChange = ManagedKey & { value?: unknown; delete?: boolean };
export type ManagedCommitState = { pending: number; error?: Error };

export interface ManagedDocumentStorage {
  readonly state: ManagedCommitState;
  subscribe(listener: () => void): () => void;
  get<T>(family: ManagedFamily, key: string): T | undefined;
  records<T>(family: ManagedFamily): readonly { key: string; value: T; version: string }[];
  commit(input: readonly ManagedChange[] | (() => readonly ManagedChange[])): Promise<unknown>;
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
