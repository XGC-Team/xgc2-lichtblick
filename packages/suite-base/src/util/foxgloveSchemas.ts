// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

// Foxglove schema-name helpers shared across layers (panels and players) so there is a single
// source of truth for which datatypes a message can carry. Lives in `util` rather than in a panel
// module to avoid inverting the player → panel dependency direction.

// Expand a single Foxglove schema name into variations for ROS1, ROS2, and IDL and add
// them to the output set.
export function addFoxgloveSchema(output: Set<string>, dataType: string): Set<string> {
  // Add the Foxglove json, protobuf, and flatbuffer variation: foxglove.PointCloud
  output.add(dataType);

  const parts = dataType.split(".");
  if (parts.length < 2) {
    throw new Error(`Invalid Foxglove schema: ${dataType}`);
  }
  const leaf = parts.slice(1).join("/");

  // Add the ROS1 variation: foxglove_msgs/PointCloud
  output.add(`foxglove_msgs/${leaf}`);

  // Add the ROS2 variation: foxglove_msgs/msg/PointCloud
  output.add(`foxglove_msgs/msg/${leaf}`);

  // Add the IDL variation: foxglove::PointCloud
  output.add(`foxglove::${leaf}`);

  return output;
}

// Schema names (all encoding variations) for `foxglove.CompressedVideo`. Shared by the 3D renderer
// and the player-side seek backfill.
export const COMPRESSED_VIDEO_DATATYPES = new Set<string>();
addFoxgloveSchema(COMPRESSED_VIDEO_DATATYPES, "foxglove.CompressedVideo");

// Complete point-cloud snapshots only; no SceneUpdate/Marker/TF inference by exclusion.
export const POINTCLOUD_SNAPSHOT_DATATYPES = new Set<string>([
  "sensor_msgs/PointCloud2",
  "sensor_msgs/msg/PointCloud2",
  "ros.sensor_msgs.PointCloud2",
]);
addFoxgloveSchema(POINTCLOUD_SNAPSHOT_DATATYPES, "foxglove.PointCloud");

// Explicit complete native samples only. OccupancyGridUpdate is never a snapshot here.
export const NATIVE_PREP_SNAPSHOT_DATATYPES = new Set<string>([
  ...POINTCLOUD_SNAPSHOT_DATATYPES,
  "nav_msgs/OccupancyGrid",
  "nav_msgs/msg/OccupancyGrid",
  "ros.nav_msgs.OccupancyGrid",
]);

export function nativePreparationKind(
  schemaName: string,
): "pointcloud" | "occupancy-grid" | undefined {
  if (POINTCLOUD_SNAPSHOT_DATATYPES.has(schemaName)) return "pointcloud";
  if (NATIVE_PREP_SNAPSHOT_DATATYPES.has(schemaName)) return "occupancy-grid";
  return undefined;
}
