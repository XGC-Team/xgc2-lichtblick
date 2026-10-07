// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import {
  isDeletionSemanticSchema,
  makeSceneLayerClearEvent,
  PARKED_FRAME_MAXIMUM_SIZE_BYTES,
} from "./parkedParsePause";

describe("isDeletionSemanticSchema", () => {
  it("matches SceneUpdate and Marker schemas in every name variant", () => {
    for (const schema of [
      "foxglove.SceneUpdate",
      "foxglove_msgs/SceneUpdate",
      "foxglove_msgs/msg/SceneUpdate",
      "foxglove::SceneUpdate",
      "visualization_msgs/Marker",
      "visualization_msgs/msg/Marker",
      "visualization_msgs/MarkerArray",
      "visualization_msgs/msg/MarkerArray",
      "studio_msgs/MarkerArray",
    ]) {
      expect(isDeletionSemanticSchema(schema)).toBe(true);
    }
  });

  it("rejects snapshot, transform, and plain append-only schemas", () => {
    for (const schema of [
      "sensor_msgs/PointCloud2",
      "sensor_msgs/Image",
      "nav_msgs/Path",
      "foxglove.Grid",
      "tf2_msgs/TFMessage",
      "tf2_msgs/msg/TFMessage",
      "geometry_msgs/PoseStamped",
      "std_msgs/Float64",
      // REMOVE has no delete-all equivalent to synthesize on resume
      "visualization_msgs/ImageMarker",
    ]) {
      expect(isDeletionSemanticSchema(schema)).toBe(false);
    }
    expect(isDeletionSemanticSchema(undefined)).toBe(false);
  });
});

describe("makeSceneLayerClearEvent", () => {
  const receiveTime = { sec: 3, nsec: 4 };

  it("clears all SceneUpdate entities on the topic", () => {
    expect(
      makeSceneLayerClearEvent({ topic: "/scene", schemaName: "foxglove.SceneUpdate", receiveTime }),
    ).toEqual({
      topic: "/scene",
      schemaName: "foxglove.SceneUpdate",
      receiveTime,
      sizeInBytes: 0,
      message: { deletions: [{ type: 1 }], entities: [] },
    });
  });

  it("clears all markers on a Marker topic with an empty-namespace DELETEALL", () => {
    const event = makeSceneLayerClearEvent({
      topic: "/markers",
      schemaName: "visualization_msgs/msg/Marker",
      receiveTime,
    });
    expect(event.message).toEqual({ action: 3, ns: "", id: 0 });
  });

  it("clears all markers on a MarkerArray topic", () => {
    const event = makeSceneLayerClearEvent({
      topic: "/markers",
      schemaName: "visualization_msgs/MarkerArray",
      receiveTime,
    });
    expect(event.message).toEqual({ markers: [{ action: 3, ns: "", id: 0 }] });
  });
});

describe("PARKED_FRAME_MAXIMUM_SIZE_BYTES", () => {
  it("bounds parked retention at 32MB", () => {
    expect(PARKED_FRAME_MAXIMUM_SIZE_BYTES).toBe(32 * 1024 * 1024);
  });
});
