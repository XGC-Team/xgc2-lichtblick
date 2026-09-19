// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

export type CustomUrdfReloadSnapshot = {
  urdf?: string;
  framePrefix?: string;
  parameter?: string;
};

/** Parked Lichtblick keeps the same URDF XML while Core swaps the display tree. */
export function customUrdfLayerNeedsReload(
  loaded: CustomUrdfReloadSnapshot,
  next: CustomUrdfReloadSnapshot,
  { forceReload = false }: { forceReload?: boolean } = {},
): boolean {
  if (forceReload) {
    return true;
  }
  return (
    loaded.urdf !== next.urdf ||
    (loaded.framePrefix ?? "") !== (next.framePrefix ?? "") ||
    (loaded.parameter ?? "") !== (next.parameter ?? "")
  );
}
