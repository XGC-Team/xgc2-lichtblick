// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { createObstacle } from "./geometry";
import { withObstacleMotion, withObstaclePose } from "./motion";
import { initialPose } from "./types";

describe("dynamic obstacle authoring", () => {
  it("translates an entire ping-pong path with the body without changing its extent", () => {
    const original = withObstacleMotion(createObstacle("Arch", "arch"), { type: "ping_pong", point_a: [1, 2, 3], point_b: [4, 5, 6], speed: 2 });
    const moved = withObstaclePose(original, initialPose([2, 4, 6]));
    expect(moved.motion).toEqual({ type: "ping_pong", point_a: [2, 4, 6], point_b: [5, 7, 9], speed: 2 });
    expect(original.pose.position).toEqual([1, 2, 3]);
    expect(moved.parts).toEqual(original.parts);
  });
  it("moves a circle center with the initial body pose and preserves phase", () => {
    const original = withObstacleMotion(createObstacle("Sphere", "sphere"), { type: "circle", center: [1, 2, 3], radius: 2, angular_speed: 1, phase: Math.PI / 2 });
    expect(original.pose.position[0]).toBeCloseTo(1);
    expect(original.pose.position[1]).toBeCloseTo(4);
    const moved = withObstaclePose(original, initialPose([5, 6, 7]));
    expect(moved.motion).toEqual({ ...original.motion, center: [5, 4, 7] });
  });
  it("changes only initial orientation when rotating a path-driven body", () => {
    const original = withObstacleMotion(createObstacle("Box", "box"), { type: "ping_pong", point_a: [0, 0, 0], point_b: [4, 0, 0], speed: 1 });
    const moved = withObstaclePose(original, { ...original.pose, orientation: [0, 0, 1, 0] });
    expect(moved.motion).toEqual(original.motion);
    expect(moved.pose.orientation).toEqual([0, 0, 1, 0]);
  });
  it("aligns initial placement when switching or editing a motion path", () => {
    const original = createObstacle("Cylinder", "cylinder");
    const moved = withObstacleMotion(original, { type: "ping_pong", point_a: [6, 7, 8], point_b: [8, 9, 10], speed: 1 });
    expect(moved.pose.position).toEqual([6, 7, 8]);
    const held = withObstacleMotion(moved, { type: "hold" });
    expect(held.pose).toEqual(moved.pose);
  });
});
