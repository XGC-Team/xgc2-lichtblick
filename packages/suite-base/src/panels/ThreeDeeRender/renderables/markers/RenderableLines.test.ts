// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";

import { RenderableLineList } from "./RenderableLineList";
import {
  RenderableLineStrip,
  lineStripPointsEqual,
  lineStripPointsExtendedBy,
} from "./RenderableLineStrip";
import { RenderableMarker } from "./RenderableMarker";
import { DynamicLineGeometry } from "../../DynamicLineGeometry";
import type { IRenderer } from "../../IRenderer";
import { Marker, MarkerType } from "../../ros";
import type { LayerSettingsMarker } from "../TopicMarkers";

type TestRenderer = Omit<IRenderer, "config"> & {
  config: Omit<IRenderer["config"], "topics"> & {
    topics: Record<string, Partial<LayerSettingsMarker>>;
  };
};

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

function makeRenderer(): TestRenderer {
  return {
    normalizeFrameId: (frame: string) => frame,
    config: { topics: {}, layers: {} },
    input: { canvasSize: new THREE.Vector2(640, 480) },
  } as unknown as TestRenderer;
}

function geometryData(geometry: DynamicLineGeometry, name: string): THREE.InterleavedBuffer {
  return (geometry.getAttribute(name) as THREE.InterleavedBufferAttribute).data;
}

describe("line strip point comparison", () => {
  const base = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 2, z: 3 },
  ];

  it("distinguishes identical, appended, diverged and shorter paths", () => {
    const appended = [...base, { x: 2, y: 4, z: 6 }];
    expect(lineStripPointsEqual(undefined, base)).toBe(false);
    expect(lineStripPointsEqual(base, [...base])).toBe(true);
    expect(lineStripPointsEqual(base, appended)).toBe(false);
    expect(lineStripPointsExtendedBy(base, appended)).toBe(true);
    expect(lineStripPointsExtendedBy(base, base)).toBe(false);
    expect(lineStripPointsExtendedBy(base, [base[0]!])).toBe(false);
    expect(
      lineStripPointsExtendedBy(base, [base[0]!, { x: 9, y: 9, z: 9 }, { x: 2, y: 4, z: 6 }]),
    ).toBe(false);
    expect(lineStripPointsExtendedBy([], [base[0]!])).toBe(true);
  });
});

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
    marker.scale.y = 0.04;
    marker.scale.z = 0.06;
    renderer.config.topics["/formation"] = {
      markerScale: 0.5,
      lineWidth: 0.01,
      color: "#00ff00ff",
    };
    const renderable = new Constructor("/formation", marker, 1n, renderer);
    expect(renderable.userData.marker.scale).toEqual({ x: 0.01, y: 0.02, z: 0.03 });
    expect(renderable.userData.marker.color).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(renderable.userData.marker.colors).toEqual([]);
    expect(marker.scale.x).toBe(0.02);
    expect(marker.colors).toEqual([{ r: 1, g: 0, b: 0, a: 0.5 }]);
    renderable.dispose();
  });

  it("applies explicit line width last even when it equals the authored width", () => {
    const marker = makeMarker(type, 4);
    marker.scale = { x: 0.2, y: 0.04, z: 0.06 };
    Object.freeze(marker.scale);
    Object.freeze(marker);
    const renderer = makeRenderer();
    renderer.config.topics["/formation"] = { markerScale: 0.5, lineWidth: 0.2 };
    const renderable = new Constructor("/formation", marker, 1n, renderer);
    expect(renderable.userData.marker.scale).toEqual({ x: 0.2, y: 0.02, z: 0.03 });
    expect(renderable.userData.marker.points).toBe(marker.points);
    for (const line of renderable.children as LineSegments2[]) {
      expect(line.material.uniforms["linewidth"]!.value).toBe(0.2);
    }
    const picking = renderable.children[1]!.userData.pickingMaterial as THREE.ShaderMaterial;
    expect(picking.uniforms["linewidth"]!.value).toBeCloseTo(0.24);
    expect(marker.scale).toEqual({ x: 0.2, y: 0.04, z: 0.06 });
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

describe("LINE_STRIP append-only path growth", () => {
  it("uploads only appended tail segments, skipping identical paths", () => {
    const renderable = new RenderableLineStrip(
      "/path",
      makeMarker(MarkerType.LINE_STRIP, 4),
      1n,
      makeRenderer(),
    );
    const geometry = (renderable.children[1] as LineSegments2).geometry as DynamicLineGeometry;
    const setPoints = jest.spyOn(geometry, "setPoints");
    const appendPoints = jest.spyOn(geometry, "appendPoints");

    // Identical values in a fresh message: no upload at all.
    renderable.update(makeMarker(MarkerType.LINE_STRIP, 4), 2n);
    expect(setPoints).not.toHaveBeenCalled();
    expect(appendPoints).not.toHaveBeenCalled();

    // Same prefix plus a tail: only the new segments are uploaded.
    const grown = makeMarker(MarkerType.LINE_STRIP, 6);
    renderable.update(grown, 3n);
    expect(appendPoints).toHaveBeenCalledTimes(1);
    expect(appendPoints).toHaveBeenCalledWith(grown.points, 4);
    expect(setPoints).not.toHaveBeenCalled();
    expect(geometry.instanceCount).toBe(5);
    expect(geometryData(geometry, "instanceStart").updateRange).toEqual({ offset: 18, count: 12 });

    // A changed prefix point forces a full upload...
    const diverged = makeMarker(MarkerType.LINE_STRIP, 6);
    diverged.points[2] = { x: -1, y: -1, z: -1 };
    renderable.update(diverged, 4n);
    expect(setPoints).toHaveBeenCalledTimes(1);
    expect(setPoints).toHaveBeenLastCalledWith(diverged.points, "strip");
    expect(appendPoints).toHaveBeenCalledTimes(1);

    // ...and so does a shorter path.
    const shorter = makeMarker(MarkerType.LINE_STRIP, 2);
    renderable.update(shorter, 5n);
    expect(setPoints).toHaveBeenCalledTimes(2);
    expect(setPoints).toHaveBeenLastCalledWith(shorter.points, "strip");
    expect(appendPoints).toHaveBeenCalledTimes(1);
    expect(geometry.instanceCount).toBe(1);
    renderable.dispose();
  });

  it("seeds appended colors from the old end point and reuses prefix pairs", () => {
    const marker = makeMarker(MarkerType.LINE_STRIP, 3);
    marker.colors = [
      { r: 1, g: 0, b: 0, a: 1 },
      { r: 0, g: 1, b: 0, a: 1 },
      { r: 0, g: 0, b: 1, a: 1 },
    ];
    const renderable = new RenderableLineStrip("/path", marker, 1n, makeRenderer());
    const geometry = (renderable.children[1] as LineSegments2).geometry as DynamicLineGeometry;

    const grown = makeMarker(MarkerType.LINE_STRIP, 5);
    grown.colors = [...marker.colors, { r: 1, g: 1, b: 0, a: 1 }, { r: 0, g: 1, b: 1, a: 0.5 }];
    renderable.update(grown, 2n);

    expect(geometry.instanceCount).toBe(4);
    // Only the two new pairs (segments 2 and 3) are marked for upload.
    expect(geometryData(geometry, "instanceColorStart").updateRange).toEqual({
      offset: 16,
      count: 16,
    });
    // The chain seeds from the old end point color: [c2, c3], [c3, c4].
    expect(Array.from(geometry.colorBuffer.slice(16, 32))).toEqual([
      0, 0, 255, 255, 255, 255, 0, 255, 255, 255, 0, 255, 0, 255, 255, 127,
    ]);
    // The previously uploaded prefix pairs [c0, c1], [c1, c2] survive the
    // append-induced buffer growth.
    expect(Array.from(geometry.colorBuffer.slice(0, 16))).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    ]);
    renderable.dispose();
  });

  it("rewrites every color pair when prefix colors change during an append", () => {
    // Base marker color only (no per-point colors).
    const renderable = new RenderableLineStrip(
      "/path",
      makeMarker(MarkerType.LINE_STRIP, 3),
      1n,
      makeRenderer(),
    );
    const geometry = (renderable.children[1] as LineSegments2).geometry as DynamicLineGeometry;

    const grown = makeMarker(MarkerType.LINE_STRIP, 5);
    grown.color = { r: 0, g: 0, b: 1, a: 1 };
    renderable.update(grown, 2n);

    // Positions take the append path...
    expect(geometry.instanceCount).toBe(4);
    expect(geometryData(geometry, "instanceStart").updateRange).toEqual({ offset: 12, count: 12 });
    // ...but the base color change invalidates the buffered prefix pairs.
    expect(geometryData(geometry, "instanceColorStart").updateRange).toEqual({
      offset: 0,
      count: 32,
    });
    expect(Array.from(geometry.colorBuffer.slice(0, 8))).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);

    // A changed per-point prefix color also forces a full color upload.
    const recolored = makeMarker(MarkerType.LINE_STRIP, 6);
    recolored.color = { r: 0, g: 0, b: 1, a: 1 };
    recolored.colors = [{ r: 1, g: 0, b: 0, a: 1 }];
    renderable.update(recolored, 3n);
    expect(geometry.instanceCount).toBe(5);
    expect(geometryData(geometry, "instanceColorStart").updateRange).toEqual({
      offset: 0,
      count: 40,
    });
    // Segment 0 now starts red and ends blue.
    expect(Array.from(geometry.colorBuffer.slice(0, 8))).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    renderable.dispose();
  });

  it("uploads in full when appending to a singleton path", () => {
    const renderable = new RenderableLineStrip(
      "/path",
      makeMarker(MarkerType.LINE_STRIP, 1),
      1n,
      makeRenderer(),
    );
    const geometry = (renderable.children[1] as LineSegments2).geometry as DynamicLineGeometry;
    expect(geometry.instanceCount).toBe(0);

    const appendPoints = jest.spyOn(geometry, "appendPoints");
    renderable.update(makeMarker(MarkerType.LINE_STRIP, 4), 2n);
    expect(appendPoints).toHaveBeenCalledTimes(1);
    expect(geometry.instanceCount).toBe(3);
    expect(geometryData(geometry, "instanceStart").updateRange).toEqual({ offset: 0, count: 18 });
    expect(geometryData(geometry, "instanceColorStart").updateRange).toEqual({
      offset: 0,
      count: 24,
    });
    renderable.dispose();
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

describe.each([
  MarkerType.ARROW,
  MarkerType.CUBE,
  MarkerType.SPHERE,
  MarkerType.CYLINDER,
  MarkerType.LINE_STRIP,
  MarkerType.LINE_LIST,
  MarkerType.CUBE_LIST,
  MarkerType.SPHERE_LIST,
  MarkerType.POINTS,
  MarkerType.TEXT_VIEW_FACING,
  MarkerType.MESH_RESOURCE,
  MarkerType.TRIANGLE_LIST,
])("display size for marker type %s", (type) => {
  it.each([0.2, 2])("multiplies only the displayed scale by %s", (markerScale) => {
    const marker = makeMarker(type, 4);
    marker.scale = { x: 0.3, y: 0.3, z: 0.3 };
    marker.colors = [{ r: 0, g: 1, b: 0, a: 0.5 }];
    Object.freeze(marker.scale);
    Object.freeze(marker);
    const renderer = makeRenderer();
    renderer.config.topics["/objects"] = { markerScale };
    const renderable = new RenderableMarker("/objects", marker, 1n, renderer);
    renderable.update(marker, 2n);
    const displayed = renderable.userData.marker;
    const expected = markerScale === 0.2 ? 0.06 : 0.6;
    expect(displayed.scale).toEqual({ x: expected, y: expected, z: expected });
    expect(displayed.pose).toBe(marker.pose);
    expect(displayed.points).toBe(marker.points);
    expect(displayed.colors).toBe(marker.colors);
    expect(displayed.color).toBe(marker.color);
    expect(displayed.header).toBe(marker.header);
    expect(renderable.userData.originalMarker).toBe(marker);
    expect(renderable.details()).toBe(marker);
    expect(renderable.userData.pose).toBe(marker.pose);
    expect(renderable.userData.messageTime).toBe(42000000007n);
    expect(renderable.userData.receiveTime).toBe(2n);
    expect(marker.scale).toEqual({ x: 0.3, y: 0.3, z: 0.3 });

    // Reapply from the original message, then restore it without cumulative scaling.
    renderable.update(marker, 3n);
    expect(renderable.userData.marker.scale).toEqual(displayed.scale);
    renderer.config.topics["/objects"] = {};
    renderable.update(marker, 4n);
    expect(renderable.userData.marker).toBe(marker);
    renderable.dispose();
  });
});

it.each([
  undefined,
  1,
  0,
  -1,
  NaN,
  Infinity,
  -Infinity,
])("preserves marker identity without a valid non-unit size multiplier (%s)", (markerScale) => {
  const marker = makeMarker(MarkerType.SPHERE, 2);
  const renderer = makeRenderer();
  renderer.config.topics["/objects"] = { markerScale };
  const renderable = new RenderableMarker("/objects", marker, 1n, renderer);
  renderable.update(marker, 2n);
  expect(renderable.userData.marker).toBe(marker);
  expect(renderable.userData.marker.scale).toBe(marker.scale);
  renderable.dispose();
});

it("preserves nonuniform signed and zero dimensions when scaling", () => {
  const marker = makeMarker(MarkerType.CUBE, 0);
  marker.scale = { x: -2, y: 0, z: 4 };
  const renderer = makeRenderer();
  renderer.config.topics["/objects"] = { markerScale: 0.5 };
  const renderable = new RenderableMarker("/objects", marker, 1n, renderer);
  renderable.update(marker, 2n);
  expect(renderable.userData.marker.scale).toEqual({ x: -1, y: 0, z: 2 });
  expect(marker.scale).toEqual({ x: -2, y: 0, z: 4 });
  renderable.dispose();
});
