// SPDX-FileCopyrightText: Copyright (C) 2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import type { UrdfRobot } from "@lichtblick/den/urdf";

import { URDF_COARSEN_ERROR_PIXELS, URDF_REFINE_ERROR_PIXELS } from "../lod";

export type VisualVariantManifest = {
  release_visual: string;
  variants: Record<string, { urdf?: string; vehicle_triangles?: number }>;
  viewer_lod?: {
    reference: string;
    metric: "sampled_surface_m";
    errors: Record<string, number>;
    link_roles: Record<string, "decorative_rotation">;
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return value != undefined && typeof value === "object" && !Array.isArray(value);
}

/** Discover only the explicit root declaration, never a package/model-name convention. */
export function visualManifestUri(text: string): string | undefined {
  const xml = new DOMParser().parseFromString(text, "text/xml");
  const declarations = Array.from(xml.documentElement.children).filter(
    (child) => child.tagName === "xgc2_visual",
  );
  if (declarations.length === 0) return undefined;
  const uri = declarations[0]!.getAttribute("manifest");
  if (declarations.length !== 1 || uri == undefined || !/^package:\/\/[^/]+\/.+/.test(uri)) {
    throw new Error("URDF xgc2_visual must declare one package:// manifest");
  }
  return uri;
}

export function parseVisualManifest(text: string): VisualVariantManifest {
  const value: unknown = JSON.parse(text);
  if (!record(value) || !record(value.variants) || typeof value.release_visual !== "string") {
    throw new Error("Invalid visual_variants manifest");
  }
  const variants = value.variants;
  const loadable = (key: string): boolean => {
    const variant = variants[key];
    return record(variant) && typeof variant.urdf === "string" && variant.urdf.length > 0;
  };
  if (!loadable(value.release_visual)) throw new Error("release_visual has no visual URDF");
  const lod = value.viewer_lod;
  if (lod != undefined) {
    if (
      !record(lod) ||
      lod.metric !== "sampled_surface_m" ||
      typeof lod.reference !== "string" ||
      !loadable(lod.reference) ||
      !record(lod.errors) ||
      !record(lod.link_roles) ||
      lod.errors[lod.reference] !== 0
    ) {
      throw new Error("Invalid viewer_lod sampled surface metadata");
    }
    for (const [key, error] of Object.entries(lod.errors)) {
      if (!loadable(key) || typeof error !== "number" || !Number.isFinite(error) || error < 0) {
        throw new Error(`Invalid sampled surface error for ${key}`);
      }
    }
    for (const role of Object.values(lod.link_roles)) {
      if (role !== "decorative_rotation") throw new Error("Unknown visual link role");
    }
  }
  return value as VisualVariantManifest;
}

/** URDF paths in this existing manifest are package-root relative, not modeling/ relative. */
export function visualVariantUri(
  manifestUri: string,
  manifest: VisualVariantManifest,
  key: string,
): string {
  const path = manifest.variants[key]?.urdf;
  const prefix = /^package:\/\/[^/]+\//.exec(manifestUri)?.[0];
  if (
    prefix == undefined ||
    path == undefined ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes(":") ||
    path.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Invalid visual URDF path for ${key}`);
  }
  return prefix + path;
}

/** Geometry/material may vary; frames, joints, origins and physical declarations must not. */
export function visualKinematicIdentity(robot: UrdfRobot): string {
  return JSON.stringify({
    links: [...robot.links]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, link]) => ({
        name,
        inertial: link.inertial,
        colliders: link.colliders,
        visuals: link.visuals.map((visual) => ({ name: visual.name, origin: visual.origin })),
      })),
    joints: [...robot.joints].sort(([a], [b]) => a.localeCompare(b)),
  });
}

/**
 * Convert asset metres using this view's actual projection/drawing-buffer pixels. This is a
 * quality estimate, not a certified surface bound. An unreliable near-plane estimate never
 * authorizes coarsening. The caller already applies its own 3D/AR display scale once.
 */
const cameraPoint = new THREE.Vector3();

export function projectedVisualError(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  viewport: THREE.Vector2,
  worldCenter: THREE.Vector3,
  worldRadius: number,
  worldError: number,
): number | undefined {
  if (
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    !Number.isFinite(worldRadius) ||
    !Number.isFinite(worldError) ||
    viewport.x <= 0 ||
    viewport.y <= 0 ||
    worldRadius < 0 ||
    worldError < 0
  )
    return undefined;
  const center = cameraPoint.copy(worldCenter).applyMatrix4(camera.matrixWorldInverse);
  const depth = -center.z - worldRadius - worldError;
  if (!Number.isFinite(depth) || depth <= camera.near) return undefined;
  const p = camera.projectionMatrix.elements;
  const z = -depth;
  const w = p[3]! * center.x + p[7]! * center.y + p[11]! * z + p[15]!;
  if (!Number.isFinite(w) || Math.abs(w) < Number.EPSILON) return undefined;
  const x = p[0]! * center.x + p[4]! * center.y + p[8]! * z + p[12]!;
  const y = p[1]! * center.x + p[5]! * center.y + p[9]! * z + p[13]!;
  const sx = viewport.x / (2 * w * w);
  const sy = viewport.y / (2 * w * w);
  // Frobenius norm includes skew/off-axis projection, without per-frame scratch arrays.
  const pixels =
    worldError *
    Math.hypot(
      (p[0]! * w - x * p[3]!) * sx,
      (p[4]! * w - x * p[7]!) * sx,
      (p[8]! * w - x * p[11]!) * sx,
      (p[1]! * w - y * p[3]!) * sy,
      (p[5]! * w - y * p[7]!) * sy,
      (p[9]! * w - y * p[11]!) * sy,
    );
  return Number.isFinite(pixels) ? pixels : undefined;
}

export function selectVisualVariant(
  manifest: VisualVariantManifest,
  current: string,
  errorPixels: (assetMetres: number) => number | undefined,
  precise: boolean,
): string {
  const lod = manifest.viewer_lod;
  if (lod == undefined) return current;
  if (precise) return lod.reference;
  const currentError = lod.errors[current];
  // An unmeasured release remains valid, but does not silently acquire an invented zero error.
  if (currentError == undefined) return current;
  const currentPixels = errorPixels(currentError);
  if (currentPixels == undefined) return lod.reference;
  const candidates = Object.entries(lod.errors)
    .filter(([, error]) => {
      const pixels = errorPixels(error);
      return pixels != undefined && pixels <= URDF_COARSEN_ERROR_PIXELS;
    })
    .sort(([, a], [, b]) => b - a);
  if (currentPixels > URDF_REFINE_ERROR_PIXELS) return candidates[0]?.[0] ?? lod.reference;
  const coarser = candidates.find(([, error]) => error > currentError);
  return coarser?.[0] ?? current;
}
