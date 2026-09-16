// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { RenderScheduler } from "./RenderScheduler";

function createFrames() {
  let nextHandle = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  return {
    callbacks,
    cancelled,
    request: (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel: (handle: number) => {
      cancelled.push(handle);
      callbacks.delete(handle);
    },
    step: () => {
      // Requests made during a callback belong to the next browser frame.
      for (const [handle, callback] of Array.from(callbacks)) {
        if (callbacks.delete(handle)) {
          callback(0);
        }
      }
    },
  };
}

describe("RenderScheduler", () => {
  it("coalesces a burst without postponing the pending frame, including handle zero", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(() => ++renders, frames.request, frames.cancel);
    for (let i = 0; i < 1_000; i++) {
      scheduler.queue();
    }
    expect(Array.from(frames.callbacks.keys())).toEqual([0]);
    expect(frames.cancelled).toEqual([]);
    frames.step();
    expect(renders).toBe(1);
    expect(frames.callbacks.size).toBe(0);
  });

  it("an immediate render consumes the pending callback instead of orphaning it", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(() => ++renders, frames.request, frames.cancel);
    scheduler.queue();
    scheduler.flush();
    expect(frames.cancelled).toEqual([0]);
    frames.step();
    expect(renders).toBe(1);
    scheduler.queue();
    frames.step();
    expect(renders).toBe(2);
  });

  it("keeps synchronous picking renders synchronous without a frequency cap", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(() => ++renders, frames.request, frames.cancel);
    scheduler.flush();
    scheduler.flush();
    expect(renders).toBe(2);
    expect(frames.callbacks.size).toBe(0);
  });

  it("retains requests raised during a render for exactly one subsequent frame", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(
      () => {
        if (++renders === 1) {
          for (let i = 0; i < 100; i++) {
            scheduler.queue();
          }
        }
      },
      frames.request,
      frames.cancel,
    );
    scheduler.queue();
    frames.step();
    expect(renders).toBe(1);
    expect(frames.callbacks.size).toBe(1);
    frames.step();
    expect(renders).toBe(2);
    expect(frames.callbacks.size).toBe(0);
  });

  it("defers reentrant immediate renders instead of recursing or losing them", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(
      () => {
        if (++renders === 1) {
          scheduler.flush();
          scheduler.flush();
        }
      },
      frames.request,
      frames.cancel,
    );
    scheduler.flush();
    expect(renders).toBe(1);
    expect(frames.callbacks.size).toBe(1);
    frames.step();
    expect(renders).toBe(2);
  });

  it("propagates an immediate render exception and permits the next render", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(
      () => {
        if (++renders === 1) {
          throw new Error("scene failure");
        }
      },
      frames.request,
      frames.cancel,
    );
    expect(() => scheduler.flush()).toThrow("scene failure");
    expect(frames.callbacks.size).toBe(0);
    scheduler.flush();
    expect(renders).toBe(2);
  });

  it("recovers from a scheduled render exception without a retry loop", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(
      () => {
        if (++renders === 1) {
          throw new Error("scene failure");
        }
      },
      frames.request,
      frames.cancel,
    );
    scheduler.queue();
    expect(() => frames.step()).toThrow("scene failure");
    expect(frames.callbacks.size).toBe(0);
    scheduler.queue();
    frames.step();
    expect(renders).toBe(2);
  });

  it("does not discard an invalidation made before a render throws", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(
      () => {
        if (++renders === 1) {
          scheduler.queue();
          throw new Error("scene failure");
        }
      },
      frames.request,
      frames.cancel,
    );
    expect(() => scheduler.flush()).toThrow("scene failure");
    expect(frames.callbacks.size).toBe(1);
    frames.step();
    expect(renders).toBe(2);
  });

  it("cancels pending work and ignores late requests after disposal", () => {
    const frames = createFrames();
    let renders = 0;
    const scheduler = new RenderScheduler(() => ++renders, frames.request, frames.cancel);
    scheduler.queue();
    const lateCallback = frames.callbacks.get(0)!;
    scheduler.dispose();
    scheduler.dispose();
    scheduler.queue();
    scheduler.flush();
    lateCallback(0);
    frames.step();
    expect(frames.cancelled).toEqual([0]);
    expect(frames.callbacks.size).toBe(0);
    expect(renders).toBe(0);
  });

  it("coalesces render requests without coalescing source samples", () => {
    const frames = createFrames();
    const messages: number[] = [];
    const received: number[] = [];
    const scheduler = new RenderScheduler(
      () => {
        received.push(...messages.splice(0));
      },
      frames.request,
      frames.cancel,
    );
    for (let i = 0; i < 1_000; i++) {
      messages.push(i);
      scheduler.queue();
    }
    frames.step();
    expect(received).toEqual(Array.from({ length: 1_000 }, (_, i) => i));
  });
});
