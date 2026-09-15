// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import { DynamicLineGeometry } from "./DynamicLineGeometry";
import type { Vector3 } from "./ros";

const points: Vector3[] = [
  { x: 10.125, y: -2.2, z: 1 },
  { x: 13.25, y: 2.8, z: 1 },
  { x: -4.5, y: 6.7, z: 3.3 },
  { x: 2, y: 9, z: -1 },
];
const attributeNames = [
  "instanceStart",
  "instanceEnd",
  "instanceColorStart",
  "instanceColorEnd",
  "instanceDistanceStart",
  "instanceDistanceEnd",
];

function data(geometry: DynamicLineGeometry, name: string): THREE.InterleavedBuffer {
  return (geometry.getAttribute(name) as THREE.InterleavedBufferAttribute).data;
}

function values(geometry: THREE.BufferGeometry, name: string, count: number): number[] {
  const attribute = geometry.getAttribute(name);
  return Array.from({ length: count }, (_, i) => {
    return attribute.itemSize === 1
      ? [attribute.getX(i)]
      : [attribute.getX(i), attribute.getY(i), attribute.getZ(i)];
  }).flat();
}

describe.each(["strip", "list"] as const)("DynamicLineGeometry %s", (topology) => {
  it("matches Three.js endpoint, distance and bounds calculations", () => {
    const reference = topology === "strip" ? new LineGeometry() : new LineSegmentsGeometry();
    reference.setPositions(points.flatMap(({ x, y, z }) => [x, y, z]));
    const line = new LineSegments2(reference);
    line.computeLineDistances();
    const geometry = new DynamicLineGeometry();
    geometry.setPoints(points, topology);
    const count = topology === "strip" ? points.length - 1 : points.length / 2;
    expect(geometry.instanceCount).toBe(count);
    for (const name of [
      "instanceStart",
      "instanceEnd",
      "instanceDistanceStart",
      "instanceDistanceEnd",
    ]) {
      expect(values(geometry, name, count)).toEqual(values(reference, name, count));
    }
    expect(geometry.boundingBox).toEqual(reference.boundingBox);
    expect(geometry.boundingSphere).toEqual(reference.boundingSphere);
    line.material.dispose();
    reference.dispose();
    geometry.dispose();
  });

  it("reuses every attribute over equal-size, shorter, empty and restored updates", () => {
    const geometry = new DynamicLineGeometry();
    geometry.setPoints(points, topology);
    const attributes = attributeNames.map((name) => geometry.getAttribute(name));
    const onDispose = jest.fn();
    geometry.addEventListener("dispose", onDispose);
    for (const update of [points, points.slice(0, 2), [], points]) {
      geometry.setPoints(update, topology);
      geometry.updateColors();
      attributeNames.forEach((name, i) => {
        expect(geometry.getAttribute(name)).toBe(attributes[i]);
      });
    }
    expect(onDispose).not.toHaveBeenCalled();
    expect(data(geometry, "instanceStart").usage).toBe(THREE.DynamicDrawUsage);
    expect(data(geometry, "instanceStart").version).toBeGreaterThan(1);
  });

  it("uploads and bounds only active segments after shrinking", () => {
    const geometry = new DynamicLineGeometry();
    geometry.setPoints(points, topology);
    const shorter = [{ x: 100, y: 101, z: 102 }, { x: 103, y: 105, z: 102 }];
    geometry.setPoints(shorter, topology);
    geometry.updateColors();
    expect(geometry.instanceCount).toBe(1);
    expect(geometry.boundingBox!.min.toArray()).toEqual([100, 101, 102]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([103, 105, 102]);
    expect(geometry.boundingSphere!.center.toArray()).toEqual([101.5, 103, 102]);
    expect(geometry.boundingSphere!.radius).toBe(2.5);
    expect(data(geometry, "instanceStart").updateRange).toEqual({ offset: 0, count: 6 });
    expect(data(geometry, "instanceDistanceStart").updateRange.count).toBe(2);
    expect(data(geometry, "instanceColorStart").updateRange.count).toBe(8);
    geometry.setPoints([], topology);
    expect(geometry.boundingBox!.isEmpty()).toBe(true);
    expect(geometry.boundingSphere!.radius).toBe(0);
  });

  it("handles initially empty and singleton input without allocating attributes", () => {
    const geometry = new DynamicLineGeometry();
    geometry.setPoints([], topology);
    geometry.updateColors();
    geometry.setPoints(points.slice(0, 1), topology);
    expect(geometry.instanceCount).toBe(0);
    expect(geometry.getAttribute("instanceStart")).toBeUndefined();
    geometry.setPoints(points, topology);
    expect(geometry.instanceCount).toBeGreaterThan(0);
  });
});

it("releases the old attributes before replacing them and grows with headroom", () => {
  const geometry = new DynamicLineGeometry();
  geometry.setPoints(points, "strip");
  const oldAttributes = attributeNames.map((name) => geometry.getAttribute(name));
  const released: Array<Array<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>> = [];
  geometry.addEventListener("dispose", () => {
    released.push(attributeNames.map((name) => geometry.getAttribute(name)));
  });
  geometry.setPoints([...points, points[0]!], "strip");
  expect(released).toHaveLength(1);
  expect(released[0]).toEqual(oldAttributes);
  const grown = geometry.getAttribute("instanceStart");
  expect(grown.count).toBe(5);
  geometry.setPoints([...points, points[0]!, points[1]!], "strip");
  expect(geometry.getAttribute("instanceStart")).toBe(grown);
  expect(released).toHaveLength(1);
});

it("retains all trajectory segments with logarithmic rather than per-point growth", () => {
  const geometry = new DynamicLineGeometry();
  const onDispose = jest.fn();
  geometry.addEventListener("dispose", onDispose);
  const history: Vector3[] = [];
  for (let i = 0; i < 1024; i++) {
    history.push({ x: i, y: i % 7, z: i % 11 });
    geometry.setPoints(history, "strip");
    expect(geometry.instanceCount).toBe(Math.max(0, history.length - 1));
  }
  expect(onDispose.mock.calls.length).toBeLessThan(25);
  expect(values(geometry, "instanceEnd", 1023).slice(-3)).toEqual([1023, 1, 0]);
});

it("does not include an unmatched LINE_LIST point in drawing or bounds", () => {
  const geometry = new DynamicLineGeometry();
  geometry.setPoints([...points.slice(0, 2), { x: 1e9, y: 1e9, z: 1e9 }], "list");
  expect(geometry.instanceCount).toBe(1);
  expect(geometry.boundingBox!.max.x).toBe(13.25);
});
