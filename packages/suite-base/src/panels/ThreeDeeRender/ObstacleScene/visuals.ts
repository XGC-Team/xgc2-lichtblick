// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import type { ScenePose, Vec3 } from "./types";

/**
 * Product look for projected obstacles, per pane:
 *
 * - 3D pane (`createObstacleSolid`): an opaque lit solid under the same scene
 *   lighting as URDF models, so spheres read as balls and cylinder walls as
 *   curved surfaces instead of flat stickers. No edge overlay and no ground
 *   projection: silhouettes come from shading, and convex parts of one
 *   obstacle share coplanar face normals, so decomposition seams shade
 *   continuously and the compound reads as one body.
 * - Image pane (`createObstacleFill`): a uniformly tinted glass fill with a
 *   fresnel rim so the silhouette stays readable over any camera background,
 *   plus crisp facet edges. Scene lighting is deliberately ignored: a lit CG
 *   material clashes with the lighting baked into the camera image.
 */

const EDGE_ANGLE_DEG = 25;
const EDGE_OPACITY = 0.9;
const EDGE_SELECTED_OPACITY = 1;
const EDGE_DARKEN = 0.55;
const FRESNEL_POWER = 3;
const FRESNEL_TINT = 0.55;
const FRESNEL_ALPHA = 0.3;
const RIM_LIGHTEN = 0.5;
const SELECT_TINT: Vec3 = [1, 0.85, 0.45];
const SELECT_MIX = 0.45;
const SOLID_EMISSIVE_LIFT = 0.3;
/** Tolerance (m) for a point to count as on/inside a sibling part's face planes. */
const SEAM_EPS = 1e-3;

/** Transparent pass order in the image pane: fill then edges, so fill depth hides far-side edges. */
export const RENDER_ORDER_FILL = 1;
export const RENDER_ORDER_EDGES = 2;

export type Rgb = [number, number, number];

type ShaderLike = { uniforms: Record<string, { value: unknown }> };

function edgeColor(color: Rgb): THREE.Color {
  return new THREE.Color(...color).multiplyScalar(EDGE_DARKEN);
}

function glsl(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/** Uniform-tint fill whose rim brightens and opacifies toward the silhouette. */
export function createObstacleFill(rgba: [...Rgb, number]): THREE.MeshBasicMaterial {
  const [r, g, b, a] = rgba;
  const base = new THREE.Color(r, g, b);
  const material = new THREE.MeshBasicMaterial({
    color: base,
    transparent: a < 1,
    opacity: a,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const rim = base.clone().lerp(new THREE.Color(1, 1, 1), RIM_LIGHTEN);
  material.userData.selected = false;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rim };
    shader.uniforms.uSelected = { value: material.userData.selected === true ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vXgcNormal;
varying vec3 vXgcView;`,
      )
      .replace(
        "#include <project_vertex>",
        `vXgcNormal = normalize(mat3(modelMatrix) * normal);
vXgcView = cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz;
#include <project_vertex>`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vXgcNormal;
varying vec3 vXgcView;
uniform vec3 uRimColor;
uniform float uSelected;`,
      )
      .replace(
        "#include <opaque_fragment>",
        `{
  float xgcFresnel = pow(1.0 - abs(dot(normalize(vXgcNormal), normalize(vXgcView))), ${glsl(FRESNEL_POWER)});
  diffuseColor.rgb = mix(diffuseColor.rgb, uRimColor, xgcFresnel * ${glsl(FRESNEL_TINT)});
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${SELECT_TINT.map(glsl).join(", ")}), uSelected * ${glsl(SELECT_MIX)});
  diffuseColor.a = min(1.0, diffuseColor.a + xgcFresnel * ${glsl(FRESNEL_ALPHA)});
}
#include <opaque_fragment>`,
      );
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => "xgc2-obstacle-fill";
  return material;
}

/**
 * Lit solid for the 3D pane. Shading from the scene lights supplies the depth
 * cues the image-pane glass deliberately avoids; coincident interior faces of
 * a convex decomposition stay invisible behind opaque depth, so no face
 * trimming or edge filtering is needed on this path.
 *
 * Lambert (pure diffuse) on purpose: a Standard GGX lobe adds a white sheen
 * that reads as gray dust on the amber. The same-hue emissive floor keeps the
 * hue vivid where the scene lights fall off, the way Gazebo's ambient keeps
 * its obstacles saturated instead of mud-brown.
 */
export function createObstacleSolid(rgba: [...Rgb, number]): THREE.MeshLambertMaterial {
  const [r, g, b, a] = rgba;
  const base = new THREE.Color(r, g, b);
  const material = new THREE.MeshLambertMaterial({
    color: base,
    transparent: a < 1,
    opacity: a,
    side: THREE.DoubleSide,
  });
  material.emissive.copy(base).multiplyScalar(SOLID_EMISSIVE_LIFT);
  material.userData.baseEmissive = material.emissive.clone();
  material.userData.selected = false;
  return material;
}

/**
 * Outward face planes of a convex part, in obstacle space. Convex-decomposed
 * obstacles share faces between sibling parts; edges lying on a shared face
 * are decomposition seams, not real silhouette features.
 */
export function convexFacePlanes(geometry: THREE.BufferGeometry, pose: ScenePose): THREE.Plane[] {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...pose.position),
    new THREE.Quaternion(...pose.orientation),
    new THREE.Vector3(1, 1, 1),
  );
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const centroid = new THREE.Vector3();
  const vertex = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    centroid.add(vertex.fromBufferAttribute(position, i));
  }
  centroid.divideScalar(Math.max(position.count, 1)).applyMatrix4(matrix);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const planes: THREE.Plane[] = [];
  const seen = new Set<string>();
  const triangleCount = Math.floor((index ? index.count : position.count) / 3);
  for (let t = 0; t < triangleCount; t++) {
    const read = (corner: number, out: THREE.Vector3) => {
      out.fromBufferAttribute(position, index ? index.getX(t * 3 + corner) : t * 3 + corner);
      out.applyMatrix4(matrix);
    };
    read(0, a);
    read(1, b);
    read(2, c);
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() < 1e-12) {
      continue;
    }
    normal.normalize();
    if (normal.dot(new THREE.Vector3().subVectors(centroid, a)) > 0) {
      normal.negate();
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, a);
    const key = `${normal.x.toFixed(4)},${normal.y.toFixed(4)},${normal.z.toFixed(
      4,
    )},${plane.constant.toFixed(4)}`;
    if (!seen.has(key)) {
      seen.add(key);
      planes.push(plane);
    }
  }
  geometry.dispose();
  return planes;
}

/**
 * Drop triangles fully covered by a sibling part. Convex-decomposed obstacles
 * carry coincident interface faces; left in place they double the translucent
 * fill and catch a grazing-angle fresnel glow that reads as a seam. Returns
 * the input unchanged when there are no siblings.
 */
export function trimSharedFaces(
  geometry: THREE.BufferGeometry,
  blockers: THREE.Plane[][],
): THREE.BufferGeometry {
  const attribute = geometry.getAttribute("position");
  if (blockers.length === 0 || attribute.count === 0) {
    return geometry;
  }
  const inside = (point: THREE.Vector3, planes: THREE.Plane[]) =>
    planes.every((plane) => plane.distanceToPoint(point) <= SEAM_EPS);
  const covered = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) =>
    blockers.some((planes) => inside(a, planes) && inside(b, planes) && inside(c, planes));
  const index = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const kept: number[] = [];
  let removedAny = false;
  const triangleCount = Math.floor((index ? index.count : attribute.count) / 3);
  for (let t = 0; t < triangleCount; t++) {
    const read = (corner: number, out: THREE.Vector3) => {
      out.fromBufferAttribute(attribute, index ? index.getX(t * 3 + corner) : t * 3 + corner);
    };
    read(0, a);
    read(1, b);
    read(2, c);
    if (covered(a, b, c)) {
      removedAny = true;
      continue;
    }
    kept.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  if (!removedAny) {
    return geometry;
  }
  const trimmed = new THREE.BufferGeometry();
  trimmed.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  trimmed.computeVertexNormals();
  geometry.dispose();
  return trimmed;
}

/**
 * Facet edges only; smooth surfaces (sphere, cylinder walls) return undefined.
 * `blockers` are sibling-part face planes in this part's local frame: an edge
 * segment whose endpoints both lie inside a sibling volume is a hidden seam.
 */
export function createObstacleEdges(
  geometry: THREE.BufferGeometry,
  color: Rgb,
  blockers: THREE.Plane[][] = [],
): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | undefined {
  let edges: THREE.BufferGeometry = new THREE.EdgesGeometry(geometry, EDGE_ANGLE_DEG);
  const attribute = edges.getAttribute("position");
  if (blockers.length > 0 && attribute.count > 0) {
    const inside = (point: THREE.Vector3, planes: THREE.Plane[]) =>
      planes.every((plane) => plane.distanceToPoint(point) <= SEAM_EPS);
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const kept: number[] = [];
    for (let i = 0; i + 1 < attribute.count; i += 2) {
      p.fromBufferAttribute(attribute, i);
      q.fromBufferAttribute(attribute, i + 1);
      if (!blockers.some((planes) => inside(p, planes) && inside(q, planes))) {
        kept.push(p.x, p.y, p.z, q.x, q.y, q.z);
      }
    }
    const filtered = new THREE.BufferGeometry();
    filtered.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
    edges.dispose();
    edges = filtered;
  }
  if (edges.getAttribute("position").count === 0) {
    edges.dispose();
    return undefined;
  }
  const material = new THREE.LineBasicMaterial({
    color: edgeColor(color),
    transparent: true,
    opacity: EDGE_OPACITY,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(edges, material);
  lines.userData.edges = true;
  lines.renderOrder = RENDER_ORDER_EDGES;
  return lines;
}

/** Selection glow for the editor. Safe before the first GL compile. */
export function setObstacleVisualSelected(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial | THREE.MeshLambertMaterial>,
  { selected }: { selected: boolean },
): void {
  const material = mesh.material;
  material.userData.selected = selected;
  if (material instanceof THREE.MeshLambertMaterial) {
    const base =
      (material.userData.baseEmissive as THREE.Color | undefined) ?? new THREE.Color(0, 0, 0);
    material.emissive.copy(base);
    if (selected) {
      material.emissive.setRGB(...SELECT_TINT).multiplyScalar(SELECT_MIX);
    }
    return;
  }
  const shader = material.userData.shader as ShaderLike | undefined;
  if (shader?.uniforms.uSelected) {
    shader.uniforms.uSelected.value = selected ? 1 : 0;
  }
  const edges = mesh.userData.edges as
    | THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    | undefined;
  if (edges) {
    edges.material.opacity = selected ? EDGE_SELECTED_OPACITY : EDGE_OPACITY;
  }
}
