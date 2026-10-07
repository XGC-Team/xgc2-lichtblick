// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { RenderScheduler } from "./RenderScheduler";

describe("RenderScheduler frame cap", () => {
  let renders: number;
  let scheduled: FrameRequestCallback[];
  let scheduler: RenderScheduler;

  const requestFrame = (callback: FrameRequestCallback): number => {
    scheduled.push(callback);
    return scheduled.length;
  };
  const cancelFrame = (): void => {};
  const runFrames = () => {
    const pending = scheduled;
    scheduled = [];
    for (const callback of pending) {
      callback(0);
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    renders = 0;
    scheduled = [];
    scheduler = new RenderScheduler(
      () => {
        renders++;
      },
      { minFrameIntervalMs: 1000 / 30, requestFrame, cancelFrame },
    );
  });

  afterEach(() => {
    scheduler.dispose();
    jest.useRealTimers();
  });

  it("renders a queued frame immediately regardless of the cap", () => {
    scheduler.queueThrottled();
    runFrames();
    expect(renders).toBe(1);
    scheduler.queueThrottled();
    expect(scheduled).toHaveLength(0); // inside the window, deferred
    scheduler.queue(); // prompt queue is never deferred and pre-empts the timer
    expect(scheduled).toHaveLength(1);
    runFrames();
    expect(renders).toBe(2);
    jest.advanceTimersByTime(34);
    expect(scheduled).toHaveLength(0); // the deferred timer was pre-empted
    runFrames();
    expect(renders).toBe(2);
  });

  it("collapses a burst of throttled invalidations into one render per interval", () => {
    scheduler.queueThrottled();
    runFrames();
    expect(renders).toBe(1);

    scheduler.queueThrottled();
    scheduler.queueThrottled();
    scheduler.queueThrottled();
    expect(scheduled).toHaveLength(0);
    jest.advanceTimersByTime(34);
    expect(scheduled).toHaveLength(1);
    scheduler.queueThrottled();
    expect(scheduled).toHaveLength(1);
    runFrames();
    expect(renders).toBe(2);
  });

  it("flush stays immediate and consumes a pending deferred frame", () => {
    scheduler.queueThrottled();
    runFrames();
    scheduler.queueThrottled();
    scheduler.flush();
    expect(renders).toBe(2);
    jest.advanceTimersByTime(100);
    runFrames();
    expect(renders).toBe(2);
  });

  it("stops scheduling after dispose", () => {
    scheduler.queueThrottled();
    runFrames();
    scheduler.queueThrottled();
    scheduler.dispose();
    jest.advanceTimersByTime(100);
    expect(scheduled).toHaveLength(0);
  });
});
