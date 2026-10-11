// SPDX-License-Identifier: MPL-2.0
import type { ServiceRef } from "@xgc2/xrpc";

export interface StartupInput {
  readonly operatorTimeZone: string;
  readonly storage: {
    readonly reference: ServiceRef;
    readonly scope: { readonly namespace: "lichtblick"; readonly user: string; readonly workspace: string };
    /** A scope of its own for the desired view; stating a view must not move the revision the pages' saves are fenced by. */
    readonly viewScope?: { readonly namespace: "lichtblick"; readonly user: string; readonly workspace: string };
    /** Headers that authorize the caller to the storage service. */
    readonly authorization: { readonly Authorization: string };
  };
  readonly assets: { readonly root: string; readonly access: "read-only" | "read-write" };
}
/** Reads and validates the private startup input file; throws a TypeError for anything else. */
export function loadStartupInput(filePath: string): StartupInput;
/** A single-link regular file with mode 0600 in a directory with mode 0700 owned by this user. */
export function readPrivateFile(filePath: string, maximum: number): Buffer;
export function checkUnixAddress(address: string, name: string): string;
