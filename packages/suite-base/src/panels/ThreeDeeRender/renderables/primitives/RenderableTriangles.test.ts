/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { SceneEntity } from "@foxglove/schemas";
import * as THREE from "three";

import { RenderableTriangles } from "./RenderableTriangles";
import { IRenderer } from "../../IRenderer";
import { LayerSettingsEntity } from "../../settings";

const settings: LayerSettingsEntity = {
  visible: true,
  showOutlines: false,
  color: undefined,
  selectedIdVariable: undefined,
};
const pose = {
  position: { x: 0, y: 0, z: 0 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
};
const entity: SceneEntity = {
  id: "ground-annotation",
  frame_id: "world",
  timestamp: { sec: 1, nsec: 0 },
  lifetime: { sec: 0, nsec: 0 },
  frame_locked: false,
  metadata: [],
  arrows: [],
  cubes: [],
  spheres: [],
  cylinders: [],
  lines: [],
  texts: [],
  models: [],
  triangles: [
    {
      pose,
      points: [
        { x: 0.18, y: 0, z: 0 },
        { x: 0, y: 0.18, z: 0 },
        { x: 0.13, y: 0, z: 0 },
      ],
      indices: [0, 1, 2],
      colors: [],
      color: { r: 1, g: 0, b: 0, a: 1 },
    },
  ],
};

it("keeps triangle annotations above opaque models without moving the ground geometry", () => {
  const renderable = new RenderableTriangles({} as IRenderer);
  renderable.update(
    "/projection",
    entity,
    { ...settings, triangleOverlay: true },
    1n,
  );
  const mesh = renderable.children[0] as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  >;
  expect(mesh.material.depthTest).toBe(false);
  expect(mesh.material.depthWrite).toBe(false);
  expect(mesh.material.transparent).toBe(true);
  expect(mesh.material.opacity).toBe(1);
  expect(mesh.renderOrder).toBe(Number.MAX_SAFE_INTEGER);
  expect(mesh.position.z).toBe(0);
  const positions = mesh.geometry.getAttribute("position");
  for (let i = 0; i < 3; i++) {
    expect(positions.getZ(i)).toBe(0);
  }
  renderable.dispose();
});

it.each([1, 0.5])(
  "restores ordinary occlusion when a pooled overlay becomes a scene mesh (alpha %s)",
  (alpha) => {
    const renderable = new RenderableTriangles({} as IRenderer);
    renderable.update(
      "/projection",
      entity,
      { ...settings, triangleOverlay: true },
      1n,
    );
    const mesh = renderable.children[0] as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    >;
    renderable.prepareForReuse();
    const obstacle = {
      ...entity,
      triangles: entity.triangles.map((tri) => ({
        ...tri,
        color: { ...tri.color, a: alpha },
      })),
    };
    renderable.update("/obstacles", obstacle, settings, 2n);
    expect(renderable.children[0]).toBe(mesh);
    expect(mesh.material.depthTest).toBe(true);
    expect(mesh.material.depthWrite).toBe(alpha === 1);
    expect(mesh.material.transparent).toBe(alpha < 1);
    expect(mesh.renderOrder).toBe(0);
    renderable.dispose();
  },
);
