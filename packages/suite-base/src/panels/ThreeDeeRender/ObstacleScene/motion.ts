// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  authoredObstacle,
  type SceneMotion,
  type SceneObstacle,
  type ScenePose,
  type Vec3,
} from "./types";

/** Moving a body moves ping-pong and circle paths. An absolute waypoint list stays independent. */
export function withObstaclePose<T extends SceneObstacle>(obstacle: T, pose: ScenePose): T {
  const delta = pose.position.map((value, index) => value - obstacle.pose.position[index]!) as Vec3;
  const translate = (point: Vec3): Vec3 =>
    point.map((value, index) => value + delta[index]!) as Vec3;
  let motion = obstacle.motion;
  if (motion.type === "ping_pong") {
    motion = { ...motion, point_a: translate(motion.point_a), point_b: translate(motion.point_b) };
  } else if (motion.type === "circle") {
    motion = { ...motion, center: translate(motion.center) };
  }
  return authoredObstacle({ ...obstacle, pose, motion }) as T;
}

/** Ping-pong and circle start at their path. Waypoint metadata does not rewrite the initial pose. */
export function withObstacleMotion(obstacle: SceneObstacle, motion: SceneMotion): SceneObstacle {
  let position = obstacle.pose.position;
  if (motion.type === "ping_pong") {
    position = [...motion.point_a];
  } else if (motion.type === "circle") {
    position = [
      motion.center[0] + motion.radius * Math.cos(motion.phase),
      motion.center[1] + motion.radius * Math.sin(motion.phase),
      motion.center[2],
    ];
  }
  return { ...obstacle, pose: { ...obstacle.pose, position }, motion };
}
