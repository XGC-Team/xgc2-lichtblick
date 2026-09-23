// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

export type CustomUrdfReloadSnapshot = {
  urdf?: string;
  framePrefix?: string;
  parameter?: string;
  scale?: number;
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
    (loaded.parameter ?? "") !== (next.parameter ?? "") ||
    urdfLayerDisplayScale(loaded) !== urdfLayerDisplayScale(next)
  );
}

/**
 * Viewer-only uniform display factor for a URDF layer. Missing or invalid
 * values fall back to true size; the simulator, collisions, and TF never see
 * this number.
 */
export function urdfLayerDisplayScale(settings: { scale?: unknown } | undefined): number {
  const scale = settings?.scale;
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
}
