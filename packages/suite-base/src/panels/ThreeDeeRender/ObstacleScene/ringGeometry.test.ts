// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { createGeometry, geometryScaleConstraint, scaleGeometry } from "./geometry";
import { createRingGeometry } from "./ringGeometry";
import { geometryValid } from "./types";

describe("parametric elliptic ring", () => {
  it.each([
    [1.2, 1, 0.05],
    [3, 1, 0.8],
  ])("keeps the hole and one closed boundary beyond the curvature radius (%s,%s,%s)", (a, b, r) => {
    const geometry = createRingGeometry([a, b], r);
    const position = geometry.getAttribute("position");
    const indices = geometry.getIndex()!;
    const edges = new Map<string, number>();
    for (let i = 0; i < indices.count; i += 3) {
      for (let j = 0; j < 3; j++) {
        const x = indices.getX(i + j);
        const y = indices.getX(i + ((j + 1) % 3));
        const key = [Math.min(x, y), Math.max(x, y)].join(":");
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].every((count) => count === 2)).toBe(true);
    expect(position.count - edges.size + indices.count / 3).toBe(0);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    expect(
      new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1)).intersectObject(
        mesh,
      ),
    ).toHaveLength(0);
    expect(
      new THREE.Raycaster(new THREE.Vector3(a, 0, 10), new THREE.Vector3(0, 0, -1)).intersectObject(
        mesh,
      ).length,
    ).toBeGreaterThan(0);
    // Independent dense ellipse oracle: vertices must lie on the tube surface,
    // including inward points where a naive normal sweep creates internal sheets.
    for (let i = 0; i < position.count; i += Math.max(1, Math.floor(position.count / 80))) {
      const point = new THREE.Vector3().fromBufferAttribute(position, i);
      let distance = Infinity;
      for (let j = 0; j < 8192; j++) {
        const angle = (2 * Math.PI * j) / 8192;
        distance = Math.min(
          distance,
          Math.hypot(point.x - a * Math.cos(angle), point.y - b * Math.sin(angle), point.z),
        );
      }
      expect(Math.abs(distance - r)).toBeLessThan(0.002);
    }
    expect(geometry.userData.ringApproximation.centerlineError).toBeLessThanOrEqual(0.0005);
    geometry.dispose();
    mesh.material.dispose();
  });

  it("preserves circular tube dimensions, named fields and radii order", () => {
    const shape = { type: "ring", radii: [3, 1], tubeRadius: 0.8 } as const;
    const mutable = { ...shape, radii: [3, 1] as [number, number] };
    expect(geometryValid(mutable)).toBe(true);
    expect(geometryScaleConstraint(mutable)).toBe("uniform");
    expect(scaleGeometry(mutable, [2, 2, 2])).toEqual({
      type: "ring",
      radii: [6, 2],
      tubeRadius: 1.6,
    });
    expect(() => scaleGeometry(mutable, [2, 1, 1])).toThrow("uniform");
    for (const invalid of [
      { ...mutable, tubeRadius: 1 },
      { ...mutable, radii: [true, 1] },
      { ...mutable, radii: [1] },
      { ...mutable, segments: 126 },
      { ...mutable, radius: 0.8 },
    ]) {
      expect(geometryValid(invalid)).toBe(false);
    }
    const geometry = createGeometry(mutable);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.max.x).toBeCloseTo(3.8, 4);
    expect(geometry.boundingBox!.max.y).toBeCloseTo(1.8, 4);
    expect(geometry.boundingBox!.max.z).toBeCloseTo(0.8, 4);
    geometry.dispose();
  });
});
