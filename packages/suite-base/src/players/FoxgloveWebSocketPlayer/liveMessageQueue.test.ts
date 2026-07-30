// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  inspectAnnexBVideoFrame,
  isTransformSchemaName,
  LiveMessageQueue,
} from "./liveMessageQueue";

describe("LiveMessageQueue", () => {
  it("supersedes replaceable telemetry by stream key when requested", () => {
    const queue = new LiveMessageQueue<string>(100);

    queue.enqueue(
      { value: "old", sizeInBytes: 10, key: "camera", retention: "replaceable" },
      { supersedeReplaceable: true },
    );
    queue.enqueue(
      { value: "new", sizeInBytes: 10, key: "camera", retention: "replaceable" },
      { supersedeReplaceable: true },
    );

    expect(queue.drain()).toEqual(["new"]);
  });

  it("keeps protected synchronization messages ordered while they fit", () => {
    const queue = new LiveMessageQueue<string>(16);

    queue.enqueue({ value: "tf-1", sizeInBytes: 8, retention: "protected" });
    const result = queue.enqueue({ value: "tf-2", sizeInBytes: 8, retention: "protected" });

    expect(result).toEqual({
      accepted: true,
      droppedEntries: 0,
      sizeLimitExceeded: false,
    });
    expect(queue.getSizeInBytes()).toBe(16);
    expect(queue.drain()).toEqual(["tf-1", "tf-2"]);
  });

  it("drops the oldest dynamic transform rather than exceeding the hard bound", () => {
    const queue = new LiveMessageQueue<string>(10);

    queue.enqueue({ value: "tf-1", sizeInBytes: 6, retention: "protected" });
    const result = queue.enqueue({
      value: "tf-2",
      sizeInBytes: 6,
      retention: "protected",
    });

    expect(result).toEqual({
      accepted: true,
      droppedEntries: 1,
      sizeLimitExceeded: false,
    });
    expect(queue.getSizeInBytes()).toBeLessThanOrEqual(10);
    expect(queue.drain()).toEqual(["tf-2"]);
  });

  it("evicts replaceable traffic before protected traffic", () => {
    const queue = new LiveMessageQueue<string>(12);

    queue.enqueue({ value: "tf-1", sizeInBytes: 6, retention: "protected" });
    queue.enqueue({ value: "image", sizeInBytes: 6, retention: "replaceable" });
    queue.enqueue({ value: "tf-2", sizeInBytes: 3, retention: "protected" });

    expect(queue.getSizeInBytes()).toBe(9);
    expect(queue.drain()).toEqual(["tf-1", "tf-2"]);
  });

  it("retains /tf_static and control-class traffic ahead of dynamic transforms", () => {
    const queue = new LiveMessageQueue<string>(12);

    queue.enqueue({
      value: "tf-static",
      sizeInBytes: 6,
      retention: "protected",
      protectedPriority: "high",
    });
    queue.enqueue({ value: "tf-dynamic-old", sizeInBytes: 6, retention: "protected" });
    queue.enqueue({ value: "tf-dynamic-new", sizeInBytes: 3, retention: "protected" });

    expect(queue.getSizeInBytes()).toBe(9);
    expect(queue.drain()).toEqual(["tf-static", "tf-dynamic-new"]);
  });

  it("eventually drops the oldest high-priority protected message to remain bounded", () => {
    const queue = new LiveMessageQueue<string>(10);

    queue.enqueue({
      value: "control-old",
      sizeInBytes: 6,
      retention: "protected",
      protectedPriority: "high",
    });
    queue.enqueue({
      value: "control-new",
      sizeInBytes: 6,
      retention: "protected",
      protectedPriority: "high",
    });

    expect(queue.getSizeInBytes()).toBe(6);
    expect(queue.drain()).toEqual(["control-new"]);
  });

  it("does not thin an H.264 GOP one delta frame at a time", () => {
    const queue = new LiveMessageQueue<string>(10);

    queue.enqueue({
      value: "idr",
      sizeInBytes: 6,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: true,
    });
    const overflow = queue.enqueue({
      value: "p-1",
      sizeInBytes: 6,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: false,
    });
    const rejectedDelta = queue.enqueue({
      value: "p-2",
      sizeInBytes: 2,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: false,
    });
    const recovery = queue.enqueue({
      value: "next-idr",
      sizeInBytes: 6,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: true,
    });

    expect(overflow).toMatchObject({ accepted: false, droppedEntries: 2 });
    expect(overflow.sizeLimitExceeded).toBe(true);
    expect(rejectedDelta).toMatchObject({ accepted: false, droppedEntries: 1 });
    expect(recovery.accepted).toBe(true);
    expect(queue.getSizeInBytes()).toBeLessThanOrEqual(10);
    expect(queue.drain()).toEqual(["next-idr"]);
  });

  it("compacts directly to a newer queued recovery point", () => {
    const queue = new LiveMessageQueue<string>(12);

    queue.enqueue({
      value: "old-p",
      sizeInBytes: 6,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: false,
    });
    queue.enqueue({
      value: "new-idr",
      sizeInBytes: 6,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: true,
    });
    queue.enqueue({
      value: "new-p",
      sizeInBytes: 3,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: false,
    });

    expect(queue.drain()).toEqual(["new-idr", "new-p"]);
  });

  it.each(["replaceable", "protected", "video"] as const)(
    "rejects one individually oversized %s entry without disturbing queued data",
    (retention) => {
      const queue = new LiveMessageQueue<string>(10);
      queue.enqueue({
        value: "retained-control",
        sizeInBytes: 5,
        retention: "protected",
        protectedPriority: "high",
      });

      const result = queue.enqueue({
        value: "oversized",
        sizeInBytes: 20,
        key: retention === "video" ? "video" : "stream",
        retention,
        isVideoRecoveryPoint: retention === "video" ? true : undefined,
      });

      expect(result).toEqual({
        accepted: false,
        droppedEntries: 1,
        sizeLimitExceeded: true,
      });
      expect(queue.getSizeInBytes()).toBe(5);
      expect(queue.drain()).toEqual(["retained-control"]);
    },
  );

  it("waits for a fitting video recovery point after rejecting an oversized frame", () => {
    const queue = new LiveMessageQueue<string>(10);

    const oversizedRecovery = queue.enqueue({
      value: "large-idr",
      sizeInBytes: 20,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: true,
    });
    const rejectedDelta = queue.enqueue({
      value: "p-frame",
      sizeInBytes: 2,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: false,
    });
    const fittingRecovery = queue.enqueue({
      value: "small-idr",
      sizeInBytes: 8,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: true,
    });

    expect(oversizedRecovery).toEqual({
      accepted: false,
      droppedEntries: 1,
      sizeLimitExceeded: true,
    });
    expect(rejectedDelta).toEqual({
      accepted: false,
      droppedEntries: 1,
      sizeLimitExceeded: false,
    });
    expect(fittingRecovery.accepted).toBe(true);
    expect(queue.getSizeInBytes()).toBe(8);
    expect(queue.drain()).toEqual(["small-idr"]);
  });

  it("keeps recovery state independent across interleaved video streams", () => {
    const queue = new LiveMessageQueue<string>(10);
    queue.enqueue({
      value: "a-idr",
      sizeInBytes: 6,
      key: "a",
      retention: "video",
      isVideoRecoveryPoint: true,
    });
    queue.enqueue({
      value: "b-idr",
      sizeInBytes: 4,
      key: "b",
      retention: "video",
      isVideoRecoveryPoint: true,
    });

    const overflowA = queue.enqueue({
      value: "a-delta-overflow",
      sizeInBytes: 2,
      key: "a",
      retention: "video",
      isVideoRecoveryPoint: false,
    });
    const rejectedA = queue.enqueue({
      value: "a-delta-rejected",
      sizeInBytes: 2,
      key: "a",
      retention: "video",
      isVideoRecoveryPoint: false,
    });
    const acceptedB = queue.enqueue({
      value: "b-delta",
      sizeInBytes: 2,
      key: "b",
      retention: "video",
      isVideoRecoveryPoint: false,
    });
    const recoveredA = queue.enqueue({
      value: "a-new-idr",
      sizeInBytes: 4,
      key: "a",
      retention: "video",
      isVideoRecoveryPoint: true,
    });

    expect(overflowA).toMatchObject({ accepted: false, droppedEntries: 2 });
    expect(rejectedA.accepted).toBe(false);
    expect(acceptedB.accepted).toBe(true);
    expect(recoveredA.accepted).toBe(true);
    expect(queue.getSizeInBytes()).toBe(10);
    expect(queue.drain()).toEqual(["b-idr", "b-delta", "a-new-idr"]);
  });

  it("keeps waiting when a recovery frame loses capacity to high-priority protected data", () => {
    const queue = new LiveMessageQueue<string>(10);
    queue.enqueue({
      value: "tf-static",
      sizeInBytes: 10,
      retention: "protected",
      protectedPriority: "high",
    });
    queue.enqueue({
      value: "oversized-idr",
      sizeInBytes: 20,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: true,
    });

    const rejectedRecovery = queue.enqueue({
      value: "fitting-idr",
      sizeInBytes: 6,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: true,
    });
    const rejectedDelta = queue.enqueue({
      value: "delta",
      sizeInBytes: 1,
      key: "video",
      retention: "video",
      isVideoRecoveryPoint: false,
    });

    expect(rejectedRecovery).toMatchObject({
      accepted: false,
      droppedEntries: 1,
      sizeLimitExceeded: true,
    });
    expect(rejectedDelta).toMatchObject({
      accepted: false,
      droppedEntries: 1,
      sizeLimitExceeded: false,
    });
    expect(queue.drain()).toEqual(["tf-static"]);
  });

  it("fails closed for a video entry without a stable stream key", () => {
    const queue = new LiveMessageQueue<string>(10);

    expect(
      queue.enqueue({
        value: "unkeyed-idr",
        sizeInBytes: 6,
        retention: "video",
        isVideoRecoveryPoint: true,
      }),
    ).toEqual({
      accepted: false,
      droppedEntries: 1,
      sizeLimitExceeded: false,
    });
    expect(queue.getSizeInBytes()).toBe(0);

    expect(
      queue.enqueue({
        value: "empty-key-idr",
        sizeInBytes: 6,
        key: "",
        retention: "video",
        isVideoRecoveryPoint: true,
      }),
    ).toMatchObject({ accepted: false, droppedEntries: 1 });
  });

  it("enforces a smaller limit immediately, preferring high-priority protected data", () => {
    const queue = new LiveMessageQueue<string>(20);
    queue.enqueue({
      value: "tf-static",
      sizeInBytes: 6,
      retention: "protected",
      protectedPriority: "high",
    });
    queue.enqueue({ value: "tf-dynamic", sizeInBytes: 6, retention: "protected" });

    queue.setMaximumSize(6);

    expect(queue.getSizeInBytes()).toBe(6);
    expect(queue.drain()).toEqual(["tf-static"]);
  });

  it("shrinks video streams independently and reports actual drops", () => {
    const queue = new LiveMessageQueue<string>(10);
    queue.enqueue({
      value: "a-idr",
      sizeInBytes: 6,
      key: "a",
      retention: "video",
      isVideoRecoveryPoint: true,
    });
    queue.enqueue({
      value: "b-idr",
      sizeInBytes: 4,
      key: "b",
      retention: "video",
      isVideoRecoveryPoint: true,
    });

    expect(queue.setMaximumSize(4)).toBe(1);
    expect(
      queue.enqueue({
        value: "a-delta",
        sizeInBytes: 1,
        key: "a",
        retention: "video",
        isVideoRecoveryPoint: false,
      }).accepted,
    ).toBe(false);
    expect(queue.drain()).toEqual(["b-idr"]);
    expect(
      queue.enqueue({
        value: "b-delta",
        sizeInBytes: 1,
        key: "b",
        retention: "video",
        isVideoRecoveryPoint: false,
      }).accepted,
    ).toBe(true);
  });

  it("rolls back supersession when the replacement cannot fit", () => {
    const queue = new LiveMessageQueue<string>(10);
    queue.enqueue({
      value: "tf-static",
      sizeInBytes: 8,
      retention: "protected",
      protectedPriority: "high",
    });
    queue.enqueue({
      value: "old-image",
      sizeInBytes: 2,
      key: "camera",
      retention: "replaceable",
    });

    const result = queue.enqueue(
      {
        value: "larger-image",
        sizeInBytes: 3,
        key: "camera",
        retention: "replaceable",
      },
      { supersedeReplaceable: true },
    );

    expect(result).toEqual({
      accepted: false,
      droppedEntries: 1,
      sizeLimitExceeded: true,
    });
    expect(queue.drain()).toEqual(["tf-static", "old-image"]);
  });

  it("reports loss of protocol-critical protected traffic", () => {
    const queue = new LiveMessageQueue<string>(10);
    queue.enqueue({
      value: "advertise-old",
      sizeInBytes: 6,
      retention: "protected",
      protectedPriority: "critical",
    });

    expect(
      queue.enqueue({
        value: "advertise-new",
        sizeInBytes: 6,
        retention: "protected",
        protectedPriority: "critical",
      }),
    ).toEqual({
      accepted: true,
      droppedEntries: 1,
      droppedCriticalEntries: 1,
      sizeLimitExceeded: false,
    });
    expect(queue.drain()).toEqual(["advertise-new"]);
  });

  it("rejects invalid byte accounting", () => {
    expect(() => new LiveMessageQueue<string>(Number.NaN)).toThrow(RangeError);
    expect(() => new LiveMessageQueue<string>(-1)).toThrow(RangeError);
    expect(() => new LiveMessageQueue<string>(1.5)).toThrow(RangeError);
    expect(() => new LiveMessageQueue<string>(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);

    const queue = new LiveMessageQueue<string>(10);
    queue.enqueue({ value: "retained", sizeInBytes: 5, retention: "protected" });
    expect(() =>
      queue.enqueue({
        value: "invalid",
        sizeInBytes: Number.POSITIVE_INFINITY,
        retention: "protected",
      }),
    ).toThrow(RangeError);
    expect(() => queue.setMaximumSize(Number.NaN)).toThrow(RangeError);
    expect(() => queue.setMaximumSize(-1)).toThrow(RangeError);
    expect(() => queue.setMaximumSize(1.5)).toThrow(RangeError);
    expect(queue.getSizeInBytes()).toBe(5);
    expect(queue.drain()).toEqual(["retained"]);
  });
});

describe("isTransformSchemaName", () => {
  it.each([
    "tf2_msgs/TFMessage",
    "tf2_msgs/msg/TFMessage",
    "ros.tf2_msgs.TFMessage",
    "geometry_msgs/TransformStamped",
    "foxglove.FrameTransform",
    "foxglove_msgs/msg/FrameTransforms",
    "custom_msgs/TFMessage",
  ])("recognizes transform schema %s", (schemaName) => {
    expect(isTransformSchemaName(schemaName)).toBe(true);
  });

  it.each([
    "sensor_msgs/Image",
    "foxglove.CompressedVideo",
    undefined,
  ])("does not classify %s as a transform schema", (schemaName) => {
    expect(isTransformSchemaName(schemaName)).toBe(false);
  });
});

describe("inspectAnnexBVideoFrame", () => {
  it("recognizes an H.264 SPS/PPS/IDR access unit as a recovery point", () => {
    const frame = new Uint8Array([
      0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5,
    ]);

    expect(inspectAnnexBVideoFrame(frame)).toEqual({
      hasParameterSet: true,
      isRecoveryPoint: true,
    });
  });

  it("does not treat an H.264 P-frame as independently decodable", () => {
    const frame = new Uint8Array([0, 0, 0, 1, 0x61, 1, 2, 3]);

    expect(inspectAnnexBVideoFrame(frame)).toEqual({
      hasParameterSet: false,
      isRecoveryPoint: false,
    });
  });

  it("requires decoder parameter sets alongside an H.264 IDR", () => {
    const frame = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]);

    expect(inspectAnnexBVideoFrame(frame)).toEqual({
      hasParameterSet: false,
      isRecoveryPoint: false,
    });
  });

  it("recognizes an H.265 VPS/SPS/PPS/IRAP access unit as a recovery point", () => {
    const frame = new Uint8Array([
      0, 0, 1, 0x40, 1, 0, 0, 1, 0x42, 2, 0, 0, 1, 0x44, 3, 0, 0, 1, 0x26, 4,
    ]);

    expect(inspectAnnexBVideoFrame(frame)).toEqual({
      hasParameterSet: true,
      isRecoveryPoint: true,
    });
  });
});
