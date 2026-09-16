// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { LineStripBuffers } from "./LineStripBuffers";

type Point = { x: number; y: number; z: number };

// Independent reference for the old LineGeometry -> LineSegments2 conversion.
function reference(points: readonly Point[]) {
  const flat = new Float32Array(points.flatMap((p) => [p.x, p.y, p.z]));
  const count = Math.max(0, points.length - 1);
  const positions = new Float32Array(count * 6);
  const distances = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions.set(flat.subarray(i * 3, i * 3 + 6), i * 6);
    let squared = 0;
    for (let j = 0; j < 3; j++) {
      const delta = flat[i * 3 + j + 3]! - flat[i * 3 + j]!;
      squared += delta * delta;
    }
    distances[i * 2] = i === 0 ? 0 : distances[i * 2 - 1]!;
    distances[i * 2 + 1] = distances[i * 2]! + Math.sqrt(squared);
  }
  return { positions, distances };
}

describe("LineStripBuffers", () => {
  it("handles empty and singleton paths without segments or non-finite bounds", () => {
    const buffers = new LineStripBuffers();
    expect(buffers.update([])).toBe(false);
    expect(buffers.segmentCount).toBe(0);
    expect(buffers.radius).toBe(0);
    expect(buffers.update([{ x: 3, y: -4, z: 5 }])).toBe(false);
    expect(buffers.min).toEqual({ x: 3, y: -4, z: 5 });
    expect(buffers.max).toEqual(buffers.min);
    expect(buffers.center).toEqual(buffers.min);
    expect(buffers.radius).toBe(0);
    expect(buffers.positions.length).toBe(0);
  });

  it("keeps every adjacent pair, including zero-length segments", () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
      { x: 3, y: 4, z: 0 },
      { x: 3, y: 4, z: 12 },
    ];
    const buffers = new LineStripBuffers();
    expect(buffers.update(points)).toBe(true);
    expect(buffers.segmentCount).toBe(3);
    expect(buffers.positions).toEqual(reference(points).positions);
    expect(Array.from(buffers.distances)).toEqual([0, 5, 5, 5, 5, 17]);
  });

  it("updates in place and does not mutate input points", () => {
    const buffers = new LineStripBuffers();
    buffers.update([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ]);
    const { positions, colors, distances } = buffers;
    const points = Object.freeze([
      Object.freeze({ x: -3, y: 4, z: 5 }),
      Object.freeze({ x: 6, y: -7, z: 8 }),
    ]);
    expect(buffers.update(points)).toBe(false);
    expect(buffers.positions).toBe(positions);
    expect(buffers.colors).toBe(colors);
    expect(buffers.distances).toBe(distances);
    expect(buffers.positions).toEqual(reference(points).positions);
    expect(buffers.distances).toEqual(reference(points).distances);
  });

  it("does not include a stale tail in bounds after shrink, empty and regrow", () => {
    const buffers = new LineStripBuffers();
    buffers.update([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 10000, y: -10000, z: 20000 },
    ]);
    const { positions, colors, distances } = buffers;
    const points = [
      { x: 10, y: 0, z: 0 },
      { x: 12, y: 0, z: 0 },
    ];
    expect(buffers.update(points)).toBe(false);
    expect(buffers.segmentCount).toBe(1);
    expect(buffers.min).toEqual(points[0]);
    expect(buffers.max).toEqual(points[1]);
    expect(buffers.center).toEqual({ x: 11, y: 0, z: 0 });
    expect(buffers.radius).toBe(1);
    buffers.update([]);
    expect(buffers.segmentCount).toBe(0);
    expect(buffers.center).toEqual({ x: 0, y: 0, z: 0 });
    expect(buffers.radius).toBe(0);
    expect(buffers.update([...points, { x: 14, y: 0, z: 0 }])).toBe(false);
    expect(buffers.positions).toBe(positions);
    expect(buffers.colors).toBe(colors);
    expect(buffers.distances).toBe(distances);
    expect(buffers.segmentCount).toBe(2);
    expect(buffers.radius).toBe(2);
  });

  it("matches Float32 segment and distance rounding across changing path sizes", () => {
    const buffers = new LineStripBuffers();
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 0x100000000 - 0.5) * 10000;
    };
    for (let run = 0; run < 100; run++) {
      const points = Array.from({ length: (run * 37) % 201 }, () => ({
        x: random(),
        y: random(),
        z: random(),
      }));
      buffers.update(points);
      const expected = reference(points);
      expect(buffers.positions.subarray(0, buffers.segmentCount * 6)).toEqual(expected.positions);
      expect(buffers.distances.subarray(0, buffers.segmentCount * 2)).toEqual(expected.distances);
      expect(Number.isFinite(buffers.radius)).toBe(true);
    }
  });

  it("grows capacity logarithmically without dropping any input point", () => {
    const buffers = new LineStripBuffers();
    const points = [{ x: 0, y: 0, z: 0 }];
    let allocations = 0;
    for (let i = 1; i <= 4096; i++) {
      points.push({ x: i, y: 0, z: 0 });
      if (buffers.update(points)) {
        allocations++;
      }
      expect(buffers.segmentCount).toBe(i);
      expect(buffers.positions[(i - 1) * 6 + 3]).toBe(i);
      expect(buffers.distances[i * 2 - 1]).toBe(i);
    }
    expect(allocations).toBe(13);
    expect(buffers.positions.length / 6).toBe(4096);
  });
});
