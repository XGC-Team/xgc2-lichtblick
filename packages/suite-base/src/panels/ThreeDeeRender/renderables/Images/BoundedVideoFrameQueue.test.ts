// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BoundedVideoFrameQueue } from "./BoundedVideoFrameQueue";

function enqueue(
  queue: BoundedVideoFrameQueue<string>,
  value: string,
  sizeInBytes: number,
  options: { isRecoveryPoint?: boolean } = {},
) {
  return queue.enqueue({
    value,
    sizeInBytes,
    isRecoveryPoint: options.isRecoveryPoint === true,
  });
}

function drain(queue: BoundedVideoFrameQueue<string>): string[] {
  const values: string[] = [];
  for (let value = queue.shift(); value != undefined; value = queue.shift()) {
    values.push(value);
  }
  return values;
}

describe("BoundedVideoFrameQueue", () => {
  it("preserves a complete GOP in order while both limits fit", () => {
    const queue = new BoundedVideoFrameQueue<string>(3, 12);

    expect(enqueue(queue, "key", 4, { isRecoveryPoint: true }).accepted).toBe(true);
    expect(enqueue(queue, "p1", 4).accepted).toBe(true);
    expect(enqueue(queue, "p2", 4).accepted).toBe(true);

    expect(queue.getLength()).toBe(3);
    expect(queue.getSizeInBytes()).toBe(12);
    expect(drain(queue)).toEqual(["key", "p1", "p2"]);
  });

  it.each([
    { maximumFrames: 3, maximumBytes: 100, label: "frame" },
    { maximumFrames: 100, maximumBytes: 9, label: "byte" },
  ])("drops only a complete old GOP at the $label limit", ({ maximumFrames, maximumBytes }) => {
    const queue = new BoundedVideoFrameQueue<string>(maximumFrames, maximumBytes);
    enqueue(queue, "old-key", 3, { isRecoveryPoint: true });
    enqueue(queue, "old-p", 3);
    enqueue(queue, "new-key", 3, { isRecoveryPoint: true });

    const result = enqueue(queue, "new-p", 3);

    expect(result).toEqual({
      accepted: true,
      droppedEntries: 2,
      resetRequired: true,
    });
    expect(queue.getLength()).toBe(2);
    expect(queue.getSizeInBytes()).toBe(6);
    expect(drain(queue)).toEqual(["new-key", "new-p"]);
  });

  it("clears an overflowing GOP and rejects deltas until recovery", () => {
    const queue = new BoundedVideoFrameQueue<string>(3, 100);
    enqueue(queue, "key", 1, { isRecoveryPoint: true });
    enqueue(queue, "p1", 1);
    enqueue(queue, "p2", 1);

    expect(enqueue(queue, "overflow", 1)).toEqual({
      accepted: false,
      droppedEntries: 4,
      resetRequired: true,
    });
    expect(enqueue(queue, "rejected-p", 1)).toEqual({
      accepted: false,
      droppedEntries: 1,
      resetRequired: false,
    });
    expect(enqueue(queue, "next-key", 1, { isRecoveryPoint: true }).accepted).toBe(true);
    expect(drain(queue)).toEqual(["next-key"]);
  });

  it("fails closed for one oversized recovery frame", () => {
    const queue = new BoundedVideoFrameQueue<string>(10, 5);
    enqueue(queue, "old-key", 2, { isRecoveryPoint: true });

    expect(enqueue(queue, "oversized-key", 6, { isRecoveryPoint: true })).toEqual({
      accepted: false,
      droppedEntries: 2,
      resetRequired: true,
    });
    expect(queue.getLength()).toBe(0);
    expect(queue.getSizeInBytes()).toBe(0);
    expect(queue.isAwaitingRecovery()).toBe(true);
  });

  it("preserves a 2000-frame long GOP at the exact frame limit", () => {
    const queue = new BoundedVideoFrameQueue<number>(2000, 2000);

    for (let index = 0; index < 2000; index++) {
      expect(
        queue.enqueue({
          value: index,
          sizeInBytes: 1,
          isRecoveryPoint: index === 0,
        }).accepted,
      ).toBe(true);
    }

    expect(queue.getLength()).toBe(2000);
    expect(queue.getSizeInBytes()).toBe(2000);
  });

  it("validates limits without changing existing state", () => {
    expect(() => new BoundedVideoFrameQueue(1.5, 10)).toThrow(RangeError);
    expect(() => new BoundedVideoFrameQueue(1, Number.NaN)).toThrow(RangeError);

    const queue = new BoundedVideoFrameQueue<string>(2, 10);
    enqueue(queue, "key", 5, { isRecoveryPoint: true });
    expect(() => enqueue(queue, "invalid", -1)).toThrow(RangeError);
    expect(drain(queue)).toEqual(["key"]);
  });
});
