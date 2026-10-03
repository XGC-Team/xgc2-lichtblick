// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";

import { RenderableLineList } from "./RenderableLineList";
import { RenderableLineStrip } from "./RenderableLineStrip";
import { RenderableMarker } from "./RenderableMarker";
import { DynamicLineGeometry } from "../../DynamicLineGeometry";
import type { IRenderer } from "../../IRenderer";
import { Marker, MarkerType } from "../../ros";

function makeMarker(type: number, count: number): Marker {
  return {
    header: { frame_id: "map", stamp: { sec: 42, nsec: 7 } },
    ns: "trajectory",
    id: 1,
    type,
    action: 0,
    pose: {
      position: { x: 1, y: 2, z: 3 },
      orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
    },
    scale: { x: 0.02, y: 0, z: 0 },
    color: { r: 1, g: 0, b: 0, a: 1 },
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    points: Array.from({ length: count }, (_, i) => ({ x: i, y: 2 * i, z: 0 })),
    colors: [],
    text: "",
    mesh_resource: "",
    mesh_use_embedded_materials: false,
  };
}

function makeRenderer(): IRenderer {
  return {
    normalizeFrameId: (frame: string) => frame,
    config: { topics: {}, layers: {} },
    input: { canvasSize: new THREE.Vector2(640, 480) },
  } as unknown as IRenderer;
}

describe.each([
  { name: "LINE_STRIP", type: MarkerType.LINE_STRIP, Constructor: RenderableLineStrip },
  { name: "LINE_LIST", type: MarkerType.LINE_LIST, Constructor: RenderableLineList },
])("$name", ({ type, Constructor }) => {
  it("accepts initial empty/singleton data, then restores both passes", () => {
    const renderable = new Constructor("/path", makeMarker(type, 0), 1n, makeRenderer());
    const lines = renderable.children as LineSegments2[];
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => !line.visible)).toBe(true);
    renderable.update(makeMarker(type, 1), 2n);
    expect(lines.every((line) => !line.visible)).toBe(true);
    renderable.update(makeMarker(type, 4), 3n);
    expect(lines.every((line) => line.visible)).toBe(true);
    expect(lines[0]!.geometry).toBe(lines[1]!.geometry);
    expect(lines[1]!.geometry.instanceCount).toBe(type === MarkerType.LINE_STRIP ? 3 : 2);
    renderable.dispose();
  });

  it("preserves pose/time, RGBA and attribute identity through continuous updates", () => {
    const marker = makeMarker(type, 4);
    const renderable = new Constructor("/path", marker, 1n, makeRenderer());
    const line = renderable.children[1] as LineSegments2;
    const geometry = line.geometry as DynamicLineGeometry;
    const positions = geometry.getAttribute("instanceStart");
    const distances = geometry.getAttribute("instanceDistanceStart");
    const colors = geometry.colorBuffer;
    marker.colors = [{ r: 0, g: 1, b: 0, a: 0.5 }];
    for (let i = 0; i < 100; i++) {
      renderable.update(marker, BigInt(i));
      expect(geometry.getAttribute("instanceStart")).toBe(positions);
      expect(geometry.getAttribute("instanceDistanceStart")).toBe(distances);
      expect(geometry.colorBuffer).toBe(colors);
    }
    expect(Array.from(colors.slice(0, 8))).toEqual([0, 255, 0, 127, 255, 0, 0, 255]);
    expect(renderable.userData.pose).toBe(marker.pose);
    expect(renderable.userData.messageTime).toBe(42000000007n);
    expect(renderable.userData.receiveTime).toBe(99n);
    expect(renderable.userData.originalMarker).toBe(marker);
    renderable.dispose();
  });

  it("restores current opacity and width after empty messages", () => {
    const renderable = new Constructor("/path", makeMarker(type, 2), 1n, makeRenderer());
    renderable.update(makeMarker(type, 0), 2n);
    const marker = makeMarker(type, 2);
    marker.color.a = 0.25;
    marker.scale.x = 0.1;
    renderable.update(marker, 3n);
    for (const line of renderable.children as LineSegments2[]) {
      expect(line.visible).toBe(true);
      expect(line.material.transparent).toBe(true);
      expect(line.material.depthWrite).toBe(false);
      expect(line.material.uniforms["linewidth"]!.value).toBe(0.1);
    }
    renderable.dispose();
  });

  it("overrides both line passes and picking without modifying the published marker", () => {
    const marker = makeMarker(type, 4);
    marker.scale.x = 0.2;
    Object.freeze(marker.scale);
    Object.freeze(marker);
    const renderer = makeRenderer();
    renderer.config.topics["/formation"] = { lineWidth: 0.01 };
    const renderable = new Constructor("/formation", marker, 1n, renderer);
    const lines = renderable.children as LineSegments2[];
    for (const line of lines) {
      expect(line.material.uniforms["linewidth"]!.value).toBe(0.01);
    }
    const picking = lines[1]!.userData.pickingMaterial as THREE.ShaderMaterial;
    expect(picking.uniforms["linewidth"]!.value).toBeCloseTo(0.012);
    expect(renderable.userData.marker.scale).toEqual({ ...marker.scale, x: 0.01 });
    expect(renderable.userData.marker.points).toBe(marker.points);
    expect(renderable.userData.marker.colors).toBe(marker.colors);
    expect(renderable.userData.originalMarker).toBe(marker);
    expect(renderable.details()).toBe(marker);
    expect(marker.scale.x).toBe(0.2);

    // Removing the display override restores the authored width.
    renderer.config.topics["/formation"] = {};
    renderable.update(marker, 2n);
    expect(renderable.userData.marker).toBe(marker);
    for (const line of lines) {
      expect(line.material.uniforms["linewidth"]!.value).toBe(0.2);
    }
    expect(picking.uniforms["linewidth"]!.value).toBeCloseTo(0.24);
    renderable.dispose();
  });

  it("combines width and color overrides while preserving the authored colors", () => {
    const marker = makeMarker(type, 4);
    marker.colors = [{ r: 1, g: 0, b: 0, a: 0.5 }];
    const renderer = makeRenderer();
    renderer.config.topics["/formation"] = { lineWidth: 0.01, color: "#00ff00ff" };
    const renderable = new Constructor("/formation", marker, 1n, renderer);
    expect(renderable.userData.marker.scale.x).toBe(0.01);
    expect(renderable.userData.marker.color).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(renderable.userData.marker.colors).toEqual([]);
    expect(marker.scale.x).toBe(0.02);
    expect(marker.colors).toEqual([{ r: 1, g: 0, b: 0, a: 0.5 }]);
    renderable.dispose();
  });

  it.each([
    0,
    -1,
    NaN,
    Infinity,
  ])("keeps the authored width for invalid override %s", (lineWidth) => {
    const marker = makeMarker(type, 4);
    const renderer = makeRenderer();
    renderer.config.topics["/formation"] = { lineWidth };
    const renderable = new Constructor("/formation", marker, 1n, renderer);
    expect(renderable.userData.marker).toBe(marker);
    for (const line of renderable.children as LineSegments2[]) {
      expect(line.material.uniforms["linewidth"]!.value).toBe(marker.scale.x);
    }
    renderable.dispose();
  });

  it("disposes the shared geometry once, all materials, and child references", () => {
    const renderable = new Constructor("/path", makeMarker(type, 4), 1n, makeRenderer());
    const lines = renderable.children as LineSegments2[];
    const geometry = lines[0]!.geometry;
    const releaseGeometry = jest.spyOn(geometry, "dispose");
    const releaseDepth = jest.spyOn(lines[0]!.material, "dispose");
    const releaseColor = jest.spyOn(lines[1]!.material, "dispose");
    const picking = lines[1]!.userData.pickingMaterial as THREE.ShaderMaterial;
    const releasePicking = jest.spyOn(picking, "dispose");
    const colorLine = lines[1]!;
    renderable.dispose();
    expect(releaseGeometry).toHaveBeenCalledTimes(1);
    expect(releaseDepth).toHaveBeenCalledTimes(1);
    expect(releaseColor).toHaveBeenCalledTimes(1);
    expect(releasePicking).toHaveBeenCalledTimes(1);
    expect(colorLine.userData.pickingMaterial).toBeUndefined();
    expect(renderable.children).toHaveLength(0);
  });
});

it.each([
  MarkerType.POINTS,
  MarkerType.SPHERE,
  MarkerType.SPHERE_LIST,
])("does not apply line width to marker type %s", (type) => {
  const marker = makeMarker(type, 2);
  const renderer = makeRenderer();
  renderer.config.topics["/objects"] = { lineWidth: 0.01 };
  const renderable = new RenderableMarker("/objects", marker, 1n, renderer);
  renderable.update(marker, 2n);
  expect(renderable.userData.marker).toBe(marker);
  expect(marker.scale.x).toBe(0.02);
  renderable.dispose();
});
