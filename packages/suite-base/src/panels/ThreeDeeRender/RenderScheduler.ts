// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

/**
 * Owns render requests, not source messages. Immediate renders (for example,
 * picking) consume a pending request; invalidations during a render request a
 * subsequent frame. queueThrottled() applies the optional frame-interval cap
 * to passive (message-driven) repaints; queue() and flush() stay immediate so
 * resize, picking and other interactions never wait.
 */
export class RenderScheduler {
  #render: () => void;
  #requestFrame: (callback: FrameRequestCallback) => number;
  #cancelFrame: (handle: number) => void;
  #minFrameIntervalMs: number;
  #lastRenderAt = -Infinity;
  #pendingFrame: number | undefined;
  #pendingTimer: ReturnType<typeof setTimeout> | undefined;
  #rendering = false;
  #disposed = false;

  public constructor(
    render: () => void,
    options: {
      minFrameIntervalMs?: number;
      requestFrame?: (callback: FrameRequestCallback) => number;
      cancelFrame?: (handle: number) => void;
    } = {},
  ) {
    this.#render = render;
    this.#minFrameIntervalMs = options.minFrameIntervalMs ?? 0;
    this.#requestFrame =
      options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.#cancelFrame =
      options.cancelFrame ??
      ((handle) => {
        cancelAnimationFrame(handle);
      });
  }

  /** Update the frame-interval cap; applies to subsequent throttled requests. */
  public setMinFrameIntervalMs(value: number): void {
    this.#minFrameIntervalMs = Math.max(0, value);
  }

  public queue(): void {
    if (this.#disposed || this.#pendingFrame != undefined) {
      return;
    }
    // A prompt request pre-empts a pending throttled timer: painting earlier is always fine.
    if (this.#pendingTimer != undefined) {
      clearTimeout(this.#pendingTimer);
      this.#pendingTimer = undefined;
    }
    this.#pendingFrame = this.#requestFrame(this.#onAnimationFrame);
  }

  /** Queue a frame unless the previous render is still within the cap window. */
  public queueThrottled(): void {
    if (this.#disposed || this.#pendingFrame != undefined || this.#pendingTimer != undefined) {
      return;
    }
    const remaining = this.#minFrameIntervalMs - (Date.now() - this.#lastRenderAt);
    if (remaining <= 0) {
      this.queue();
      return;
    }
    // Inside the interval: request the frame only when the cap has elapsed, so
    // a burst of invalidations still collapses into one render.
    this.#pendingTimer = setTimeout(() => {
      this.#pendingTimer = undefined;
      this.queue();
    }, remaining);
  }

  public flush(): void {
    if (this.#disposed) {
      return;
    }
    if (this.#rendering) {
      // Do not recurse or lose an invalidation raised by a render listener.
      this.queue();
      return;
    }

    this.#cancelPendingFrame();
    this.#rendering = true;
    try {
      this.#render();
      this.#lastRenderAt = Date.now();
    } finally {
      // A failed scene extension must not permanently disable future renders.
      // Preserve the original exception instead of hiding it or retry-spinning.
      this.#rendering = false;
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#cancelPendingFrame();
  }

  #onAnimationFrame = (): void => {
    this.#pendingFrame = undefined;
    this.flush();
  };

  #cancelPendingFrame(): void {
    if (this.#pendingFrame != undefined) {
      this.#cancelFrame(this.#pendingFrame);
      this.#pendingFrame = undefined;
    }
    if (this.#pendingTimer != undefined) {
      clearTimeout(this.#pendingTimer);
      this.#pendingTimer = undefined;
    }
  }
}
