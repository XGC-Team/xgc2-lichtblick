// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  makeStandardInstancedMaterial,
  makeStandardMaterial,
  makeStandardVertexColorMaterial,
} from "./materials";
import { Marker, MarkerType } from "../../ros";

function makeMarker(type: MarkerType, alpha: number): Marker {
  return {
    header: { frame_id: "map", stamp: { sec: 0, nsec: 0 } },
    ns: "obstacle",
    id: 0,
    type,
    action: 0,
    pose: {
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    scale: { x: 1, y: 1, z: 1 },
    color: { r: 1, g: 0.5, b: 0.1, a: alpha },
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    points: [{ x: 0, y: 0, z: 0 }],
    colors: [],
    text: "",
    mesh_resource: "",
    mesh_use_embedded_materials: false,
  };
}

describe("marker mesh materials", () => {
  it.each([
    ["makeStandardMaterial", () => makeStandardMaterial({ r: 1, g: 0.5, b: 0.1, a: 0.8 })],
    [
      "makeStandardVertexColorMaterial",
      () => makeStandardVertexColorMaterial(makeMarker(MarkerType.TRIANGLE_LIST, 0.8)),
    ],
    [
      "makeStandardInstancedMaterial",
      () => makeStandardInstancedMaterial(makeMarker(MarkerType.CUBE_LIST, 0.8)),
    ],
  ])("%s keeps depth write enabled for translucent solids", (_name, make) => {
    const material = make();
    // Writing depth culls coincident interior faces of adjacent convex parts
    // so translucent overlays do not double-blend along decomposition seams.
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(true);
  });
});
