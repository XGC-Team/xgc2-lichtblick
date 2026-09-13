// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { PinholeCameraModel } from "@lichtblick/den/image";

import { ImageModeCamera } from "./ImageModeCamera";

function calibratedCamera(): ImageModeCamera {
  const camera = new ImageModeCamera();
  camera.setCanvasSize(640, 480);
  camera.updateCamera(
    new PinholeCameraModel({
      width: 640,
      height: 480,
      binning_x: 0,
      binning_y: 0,
      distortion_model: "plumb_bob",
      D: [0, 0, 0, 0, 0],
      K: [500, 0, 320, 0, 500, 240, 0, 0, 1],
      R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      P: [500, 0, 320, 0, 0, 500, 240, 0, 0, 0, 1, 0],
      roi: { x_offset: 0, y_offset: 0, width: 0, height: 0, do_rectify: false },
    }),
  );
  return camera;
}

describe("ImageModeCamera depth and calibration", () => {
  it("resolves millimetre-separated surfaces at a 20 metre field distance", () => {
    const camera = calibratedCamera();
    const depth = (distance: number) =>
      (new THREE.Vector3(0, 0, -distance).applyMatrix4(camera.projectionMatrix).z + 1) / 2;
    // More than one 24-bit depth step; the former 1 mm near plane merged these surfaces.
    expect((depth(20.001) - depth(20)) * (2 ** 24 - 1)).toBeGreaterThan(4);
    expect(depth(camera.near)).toBeCloseTo(0, 10);
    expect(depth(camera.far)).toBeCloseTo(1, 10);
  });

  it("preserves calibrated pixel coordinates and inverse projection", () => {
    const camera = calibratedCamera();
    const point = new THREE.Vector3(1, 0.5, -10);
    const projected = point.clone().applyMatrix4(camera.projectionMatrix);
    expect(((projected.x + 1) * 640) / 2).toBeCloseTo(370, 8);
    expect(((1 - projected.y) * 480) / 2).toBeCloseTo(215, 8);
    expect(projected.applyMatrix4(camera.projectionMatrixInverse).distanceTo(point)).toBeLessThan(1e-10);
  });
});
