// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";

import { RenderableLineStrip } from "./RenderableLineStrip";
import type { IRenderer } from "../../IRenderer";
import { LineMaterialWithAlphaVertex } from "../../LineMaterialWithAlphaVertex";
import { Marker, MarkerAction, MarkerType } from "../../ros";

function marker(points: Marker["points"], overrides: Partial<Marker> = {}): Marker {
  return {
    header: { frame_id: "world", stamp: { sec: 12, nsec: 34 } },
    ns: "path", id: 1, type: MarkerType.LINE_STRIP, action: MarkerAction.ADD,
    pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0.6, w: 0.8 } },
    scale: { x: 0.1, y: 1, z: 1 }, color: { r: 1, g: 1, b: 1, a: 1 },
    lifetime: { sec: 0, nsec: 0 }, frame_locked: true, points, colors: [], text: "",
    mesh_resource: "", mesh_use_embedded_materials: false,
    ...overrides,
  };
}

function makeRenderable(message: Marker) {
  const renderer = {
    config: { topics: {}, layers: {} },
    input: { canvasSize: new THREE.Vector2(640, 480) },
    normalizeFrameId: (frameId: string) => frameId,
  } as unknown as IRenderer;
  const renderable = new RenderableLineStrip("/path", message, 123n, renderer);
  const [depth, color] = renderable.children as [Line2, Line2];
  return { renderable, depth, color };
}

function buffer(line: Line2, name: string): THREE.InterleavedBuffer {
  return (line.geometry.getAttribute(name) as THREE.InterleavedBufferAttribute).data;
}

const points = Array.from({ length: 5 }, (_, x) => ({ x, y: 0, z: 0 }));

describe("RenderableLineStrip buffer lifecycle", () => {
  it("shares and reuses geometry/attributes for all passes across same-capacity updates", () => {
    const { renderable, depth, color } = makeRenderable(marker(points));
    const geometry = color.geometry;
    const positions = buffer(color, "instanceStart");
    const colors = buffer(color, "instanceColorStart");
    const distances = buffer(color, "instanceDistanceStart");
    try {
      const changed = marker(points.map((p) => ({ ...p, y: 2 })));
      renderable.update(changed, 456n);
      expect(depth.geometry).toBe(geometry);
      expect(color.geometry).toBe(geometry);
      expect(buffer(color, "instanceStart")).toBe(positions);
      expect(buffer(color, "instanceColorStart")).toBe(colors);
      expect(buffer(color, "instanceDistanceStart")).toBe(distances);
      expect(positions.array[1]).toBe(2);
      expect(positions.usage).toBe(THREE.DynamicDrawUsage);
      expect(positions.updateRange).toEqual({ offset: 0, count: 24 });
      expect(distances.updateRange).toEqual({ offset: 0, count: 8 });
      expect(renderable.userData.messageTime).toBe(12000000034n);
      expect(renderable.userData.receiveTime).toBe(456n);
      expect(renderable.userData.pose).toBe(changed.pose);
      expect(renderable.userData.originalMarker).toBe(changed);
    } finally {
      renderable.dispose();
    }
  });

  it("restricts rendering and bounds to active segments after shrink and reuses capacity on regrow", () => {
    const { renderable, depth, color } = makeRenderable(marker([...points, { x: 10000, y: 0, z: 0 }]));
    const geometry = color.geometry;
    try {
      renderable.update(marker([{ x: 10, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }]), 200n);
      expect(color.geometry).toBe(geometry);
      expect(geometry.instanceCount).toBe(1);
      expect(geometry.boundingBox?.min.x).toBe(10);
      expect(geometry.boundingBox?.max.x).toBe(12);
      expect(geometry.boundingSphere?.radius).toBe(1);
      renderable.update(marker([]), 201n);
      expect(depth.visible).toBe(false);
      expect(color.visible).toBe(false);
      expect(geometry.instanceCount).toBe(0);
      renderable.update(marker([{ x: 9, y: 8, z: 7 }]), 202n);
      expect(color.visible).toBe(false);
      expect(geometry.boundingSphere?.radius).toBe(0);
      renderable.update(marker(points), 203n);
      expect(color.geometry).toBe(geometry);
      expect(depth.visible).toBe(true);
      expect(color.visible).toBe(true);
      expect(geometry.instanceCount).toBe(4);
    } finally {
      renderable.dispose();
    }
  });

  it("preserves per-vertex RGBA, including alpha, in adjacent segment pairs", () => {
    const { renderable, color } = makeRenderable(marker(points.slice(0, 3), {
      colors: [
        { r: 1, g: 0, b: 0, a: 1 },
        { r: 0, g: 1, b: 0, a: 0.5 },
        { r: 0, g: 0, b: 1, a: 0.25 },
      ],
    }));
    try {
      expect(Array.from(buffer(color, "instanceColorStart").array)).toEqual([
        255, 0, 0, 255, 0, 255, 0, 127,
        0, 255, 0, 127, 0, 0, 255, 63,
      ]);
      expect(buffer(color, "instanceColorEnd")).toBe(buffer(color, "instanceColorStart"));
    } finally {
      renderable.dispose();
    }
  });

  it("recovers opaque materials after an empty update and keeps picking width in sync", () => {
    const { renderable, depth, color } = makeRenderable(marker(points, {
      color: { r: 1, g: 1, b: 1, a: 0.5 },
    }));
    try {
      renderable.update(marker([]), 124n);
      renderable.update(marker(points, { scale: { x: 0.4, y: 1, z: 1 } }), 125n);
      expect(depth.material.transparent).toBe(false);
      expect(color.material.transparent).toBe(false);
      expect(color.material.depthWrite).toBe(true);
      expect((color.material as LineMaterialWithAlphaVertex).lineWidth).toBe(0.4);
      const picking = color.userData.pickingMaterial as THREE.ShaderMaterial;
      expect(picking.uniforms["linewidth"]?.value).toBeCloseTo(0.48);
    } finally {
      renderable.dispose();
    }
  });

  it("disposes replaced storage on growth and the final shared geometry exactly once", () => {
    const { renderable, depth, color } = makeRenderable(marker(points.slice(0, 2)));
    const oldGeometry = color.geometry;
    const oldDispose = jest.spyOn(oldGeometry, "dispose");
    renderable.update(marker(points), 200n);
    expect(color.geometry).not.toBe(oldGeometry);
    expect(depth.geometry).toBe(color.geometry);
    expect(oldDispose).toHaveBeenCalledTimes(1);
    const geometryDispose = jest.spyOn(color.geometry, "dispose");
    const depthDispose = jest.spyOn(depth.material, "dispose");
    const colorDispose = jest.spyOn(color.material, "dispose");
    const picking = color.userData.pickingMaterial as THREE.ShaderMaterial;
    const pickingDispose = jest.spyOn(picking, "dispose");
    renderable.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(depthDispose).toHaveBeenCalledTimes(1);
    expect(colorDispose).toHaveBeenCalledTimes(1);
    expect(pickingDispose).toHaveBeenCalledTimes(1);
  });
});
