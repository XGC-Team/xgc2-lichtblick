// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import type { UrdfGeometry, UrdfJoint, UrdfRobot } from "@lichtblick/den/urdf";

/**
 * Screen-size-driven model LOD for URDF robots.
 *
 * Robot description packages ship tier URDFs next to the default
 * `urdf/<robot>_visual.urdf` with the unified logical mapping
 * `high → lod10k, medium → lod_medium, low → lod1500`
 * (`urdf/scout_visual_lod10k.urdf`, `..._lod_medium.urdf`, `..._lod1500.urdf`;
 * FS150 follows the same pattern). Tier URDFs differ ONLY in visual mesh
 * URIs — identical links, joints, origins and scales — so a tier swap only
 * replaces visual geometry and never touches TF. `*_visual_detail.urdf` is a
 * preserved previous default, NOT a tier, and is never derived here.
 *
 * A default URDF can be the original reference model rather than `lod10k`.
 * Only an explicitly named tier URL identifies an already-loaded tier.
 */

export type UrdfLodTier = "high" | "medium" | "low";
export type UrdfLodMode = "auto" | UrdfLodTier;

/** URDF filename suffix of each tier, per the robot-description package contract. */
export const URDF_LOD_TIER_SUFFIX: Record<UrdfLodTier, string> = {
  high: "lod10k",
  medium: "lod_medium",
  low: "lod1500",
};

export const URDF_LOD_TIERS: readonly UrdfLodTier[] = ["high", "medium", "low"];

/**
 * On-screen bounding-sphere diameter (CSS px) at which each tier enters. The
 * product comparison tooling rendered the tiers at 32/64/128/256/512 px; the
 * boundaries sit between the sampled scales: high above 512 px, medium from
 * 128–512 px, low below 128 px.
 */
export const URDF_LOD_HIGH_MIN_PX = 512;
export const URDF_LOD_MEDIUM_MIN_PX = 128;

/**
 * Hysteresis margin around each entry threshold: a switch down needs the size
 * below threshold·(1-margin), a switch up needs it above threshold·(1+margin),
 * so a robot hovering at a boundary (127 px ↔ 129 px) never thrashes tiers.
 */
export const URDF_LOD_HYSTERESIS = 0.15;

/** Floor for the model bounding radius so point-sized robots still get a tier. */
const MIN_BOUNDING_RADIUS = 0.1;

/** Per-tier URDF URLs for one robot; `high` is present whenever a base resolved. */
export type UrdfLodBase = {
  tiers: Record<UrdfLodTier, string>;
};

/** LOD bookkeeping of one loaded robot (one URDF layer). */
export type UrdfLodState = {
  /** Loaded tier, or undefined while showing an unclassified default model. */
  currentTier: UrdfLodTier | undefined;
  /** Tier whose swap is in flight, if any. */
  pendingTier: UrdfLodTier | undefined;
  /** Tiers whose fetch/parse failed; auto mode stops requesting them. */
  failedTiers: Set<UrdfLodTier>;
  /** Resolved tier URLs, or undefined when no base could be derived. */
  base: UrdfLodBase | undefined;
  /** Unscaled model bounding radius in meters (layer scale applied per frame). */
  radius: number;
  /** Last mode seen by the evaluator; a mode change clears failedTiers. */
  lastMode: UrdfLodMode;
};

export function isUrdfLodMode(value: unknown): value is UrdfLodMode {
  return value === "auto" || value === "high" || value === "medium" || value === "low";
}

const TIER_SUFFIX_PATTERN = /_(?:lod10k|lod_medium|lod1500)$/i;

/**
 * The tier a URDF URL names by filename suffix, or undefined for the plain
 * default (`scout_visual.urdf`) and for non-tier files (`_detail` is not one).
 */
export function urdfTierFromUrl(url: string): UrdfLodTier | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const match = /([^/]+?)(?:\.urdf)$/i.exec(pathname);
  if (!match) {
    return undefined;
  }
  const stem = match[1]!;
  for (const tier of URDF_LOD_TIERS) {
    if (stem.toLowerCase().endsWith(`_${URDF_LOD_TIER_SUFFIX[tier].toLowerCase()}`)) {
      return tier;
    }
  }
  return undefined;
}

/**
 * Derive one tier's URDF URL from the default URDF location by filename
 * convention: `.../urdf/scout_visual.urdf` → `.../urdf/scout_visual_lod1500.urdf`.
 * A tier URL as input (`scout_visual_lod10k.urdf`) is normalized to the same
 * stem first, so any file of the set derives the same siblings. Returns
 * undefined when the URL does not name a `.urdf` file.
 */
export function deriveUrdfTierUrl(baseUrdfUrl: string, tier: UrdfLodTier): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrdfUrl);
  } catch {
    return undefined;
  }
  const path = url.pathname;
  const match = /([^/]+?)(?:\.urdf)$/i.exec(path);
  if (!match) {
    return undefined;
  }
  const stem = match[1]!.replace(TIER_SUFFIX_PATTERN, "");
  const suffixStart = path.length - match[0].length;
  url.pathname = `${path.slice(0, suffixStart)}${stem}_${URDF_LOD_TIER_SUFFIX[tier]}.urdf`;
  return url.toString();
}

/** Derive every tier URL from a URL/file-sourced default URDF. */
export function deriveUrdfTierUrlsFromUrl(baseUrdfUrl: string): UrdfLodBase | undefined {
  const tiers: Partial<Record<UrdfLodTier, string>> = {};
  for (const tier of URDF_LOD_TIERS) {
    const url = deriveUrdfTierUrl(baseUrdfUrl, tier);
    if (url == undefined) {
      return undefined;
    }
    tiers[tier] = url;
  }
  return { tiers: tiers as Record<UrdfLodTier, string> };
}

/**
 * Derive tier URLs for a parameter/topic-sourced URDF, which has no URL of its
 * own. Mesh loading for such robots already resolves `package://` URIs through
 * the asset pipeline, so the tier base comes from the same place: the first
 * mesh `package://<robot>_description/` URI plus the package contract
 * location `urdf/<robot>_visual_<tier>.urdf`. The XML robot name is independent
 * of this resource filename. Returns undefined when the URDF
 * references no package (e.g. primitive-only models) — auto LOD then degrades
 * to the default tier only.
 */
export function deriveUrdfTierUrlsFromContent(urdfText: string): UrdfLodBase | undefined {
  const pkg = /<mesh\b[^>]*\bfilename\s*=\s*["']package:\/\/([^/"']+)\//.exec(urdfText)?.[1];
  if (pkg == undefined) {
    return undefined;
  }
  const robotName = pkg.replace(/_description$/, "");
  const stem = `package://${pkg}/urdf/${robotName}_visual`;
  return {
    tiers: {
      high: `${stem}_${URDF_LOD_TIER_SUFFIX.high}.urdf`,
      medium: `${stem}_${URDF_LOD_TIER_SUFFIX.medium}.urdf`,
      low: `${stem}_${URDF_LOD_TIER_SUFFIX.low}.urdf`,
    },
  };
}

/**
 * Tier selection with hysteresis. The current tier holds while the size stays
 * inside the band threshold·(1±URDF_LOD_HYSTERESIS) around its entry points;
 * large jumps settle across multiple bands in one call. The comparison is
 * purely on the projected bounding-sphere diameter in CSS px.
 */
export function selectUrdfLodTier(sizePx: number, current: UrdfLodTier): UrdfLodTier {
  let tier = current;
  // Step down while clearly below the current tier's entry threshold.
  for (;;) {
    const entry =
      tier === "high" ? URDF_LOD_HIGH_MIN_PX : tier === "medium" ? URDF_LOD_MEDIUM_MIN_PX : 0;
    if (entry === 0 || sizePx >= entry * (1 - URDF_LOD_HYSTERESIS)) {
      break;
    }
    tier = tier === "high" ? "medium" : "low";
  }
  // Step up while clearly above the next tier's entry threshold.
  for (;;) {
    const next =
      tier === "low" ? URDF_LOD_MEDIUM_MIN_PX : tier === "medium" ? URDF_LOD_HIGH_MIN_PX : 0;
    if (next === 0 || sizePx < next * (1 + URDF_LOD_HYSTERESIS)) {
      break;
    }
    tier = tier === "low" ? "medium" : "high";
  }
  return tier;
}

export type UrdfScreenSizeCamera =
  | { kind: "perspective"; fovDeg: number; zoom: number }
  /** World-space height of the view, zoom applied. */
  | { kind: "orthographic"; height: number };

/**
 * Projected on-screen diameter (CSS px) of a world-space bounding sphere —
 * the standard screen-space error projection, no render pass. Perspective
 * divides the sphere by the frustum height at its distance; orthographic
 * divides by the view height directly.
 */
export function urdfScreenSizePx(args: {
  radius: number;
  distance: number;
  viewportHeightPx: number;
  camera: UrdfScreenSizeCamera;
}): number {
  const { radius, distance, viewportHeightPx, camera } = args;
  if (!(radius > 0) || !(viewportHeightPx > 0)) {
    return 0;
  }
  if (camera.kind === "orthographic") {
    return camera.height > 0 ? ((2 * radius) / camera.height) * viewportHeightPx : 0;
  }
  const tanHalfFov = Math.tan((camera.fovDeg * Math.PI) / 360);
  if (!(tanHalfFov > 0) || !(camera.zoom > 0)) {
    return 0;
  }
  const clampedDistance = Math.max(distance, 1e-3);
  return ((2 * radius) / (2 * clampedDistance * tanHalfFov)) * viewportHeightPx * camera.zoom;
}

/**
 * Conservative bounding radius of a parsed robot, computed once per parsed
 * model: for every link, the summed magnitudes of joint-origin translations
 * from the root (rotation-independent, so folding joints overestimate rather
 * than clip), plus each visual's origin offset and geometry extent. Mesh
 * extents use the URDF scale against a unit model — meshes are authored at
 * real size, so this underestimates at most a single link's own span, which
 * the summed chain offsets already cover.
 */
export function urdfModelBoundingRadius(robot: UrdfRobot): number {
  const jointByChild = new Map<string, UrdfJoint>();
  for (const joint of robot.joints.values()) {
    jointByChild.set(joint.child, joint);
  }
  const offsetCache = new Map<string, number>();
  const visiting = new Set<string>();
  const distFromRoot = (link: string): number => {
    const cached = offsetCache.get(link);
    if (cached != undefined) {
      return cached;
    }
    const joint = jointByChild.get(link);
    if (!joint || visiting.has(link)) {
      return 0;
    }
    visiting.add(link);
    const dist = magnitude(joint.origin.xyz) + distFromRoot(joint.parent);
    visiting.delete(link);
    offsetCache.set(link, dist);
    return dist;
  };
  let radius = MIN_BOUNDING_RADIUS;
  for (const link of robot.links.values()) {
    const linkDist = distFromRoot(link.name);
    radius = Math.max(radius, linkDist);
    for (const visual of [...link.visuals, ...link.colliders]) {
      radius = Math.max(
        radius,
        linkDist + magnitude(visual.origin.xyz) + geometryExtent(visual.geometry),
      );
    }
  }
  return radius;
}

function magnitude(xyz: { x: number; y: number; z: number }): number {
  return Math.hypot(xyz.x, xyz.y, xyz.z);
}

function geometryExtent(geometry: UrdfGeometry): number {
  switch (geometry.geometryType) {
    case "box":
      return 0.5 * magnitude(geometry.size);
    case "cylinder":
      return Math.hypot(geometry.radius, geometry.length / 2);
    case "sphere":
      return geometry.radius;
    case "mesh":
      return 0.5 * magnitude(geometry.scale ?? { x: 1, y: 1, z: 1 });
  }
}
