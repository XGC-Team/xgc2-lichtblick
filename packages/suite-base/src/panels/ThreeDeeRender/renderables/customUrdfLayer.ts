export type CustomUrdfReloadSnapshot = {
  urdf?: string;
  framePrefix?: string;
  parameter?: string;
};

/** Parked Lichtblick keeps the same URDF XML while Core swaps the display tree. */
export function customUrdfLayerNeedsReload(
  loaded: CustomUrdfReloadSnapshot,
  next: CustomUrdfReloadSnapshot,
  forceReload = false,
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
