// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BoundedVideoFrameQueue } from "./BoundedVideoFrameQueue";

// eslint-disable-next-line @lichtblick/no-boolean-parameters
const entry = (value: number, isRecoveryPoint = false, sizeInBytes = 1) => ({
  value,
  isRecoveryPoint,
  sizeInBytes,
});

describe("video queue hot path", () => {
  it("keeps FIFO/byte accounting through repeated head compaction", () => {
    const queue = new BoundedVideoFrameQueue<number>(2000, 4000);
    for (let value = 0; value < 1500; value++) {
      queue.enqueue(entry(value, value === 0, 2));
    }
    for (let value = 0; value < 10_000; value++) {
      expect(queue.shift()).toBe(value);
      queue.enqueue(entry(value + 1500, false, 2));
      expect(queue.getLength()).toBe(1500);
      expect(queue.getSizeInBytes()).toBe(3000);
    }
    for (let value = 10_000; value < 11_500; value++) {
      expect(queue.shift()).toBe(value);
    }
    expect(queue.getLength()).toBe(0);
    expect(queue.getSizeInBytes()).toBe(0);
    expect(queue.shift()).toBeUndefined();
  });

  it("does not recover from a keyframe that has already been consumed", () => {
    const queue = new BoundedVideoFrameQueue<number>(3, 3);
    queue.enqueue(entry(0, true));
    queue.enqueue(entry(1));
    expect(queue.shift()).toBe(0);
    queue.enqueue(entry(2));
    queue.enqueue(entry(3));
    expect(queue.enqueue(entry(4))).toEqual({
      accepted: false,
      droppedEntries: 4,
      resetRequired: true,
    });
    expect(queue.isAwaitingRecovery()).toBe(true);
    expect(queue.enqueue(entry(5, true)).accepted).toBe(true);
    expect(queue.shift()).toBe(5);
  });

  it("recovers to the newest queued GOP with a nonzero head", () => {
    const queue = new BoundedVideoFrameQueue<number>(4, 4);
    queue.enqueue(entry(0, true));
    queue.enqueue(entry(1));
    queue.shift();
    queue.enqueue(entry(2, true));
    queue.enqueue(entry(3));
    queue.enqueue(entry(4));
    expect(queue.enqueue(entry(5))).toEqual({
      accepted: true,
      droppedEntries: 1,
      resetRequired: true,
    });
    expect(queue.getSizeInBytes()).toBe(4);
    expect([queue.shift(), queue.shift(), queue.shift(), queue.shift()]).toEqual([2, 3, 4, 5]);
  });

  it("keeps overflow arithmetic exact near the safe integer ceiling", () => {
    const queue = new BoundedVideoFrameQueue<number>(3, Number.MAX_SAFE_INTEGER);
    queue.enqueue(entry(0, true, Number.MAX_SAFE_INTEGER - 1));
    expect(queue.enqueue(entry(1, false, 1)).accepted).toBe(true);
    expect(queue.getSizeInBytes()).toBe(Number.MAX_SAFE_INTEGER);
    expect(queue.enqueue(entry(2, true, 1))).toEqual({
      accepted: true,
      droppedEntries: 2,
      resetRequired: true,
    });
    expect(queue.getSizeInBytes()).toBe(1);
    expect(queue.shift()).toBe(2);
  });
});
