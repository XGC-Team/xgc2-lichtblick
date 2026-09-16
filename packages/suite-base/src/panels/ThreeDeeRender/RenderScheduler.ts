// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

/**
 * Owns render requests, not source messages. Immediate renders (for example,
 * picking) consume a pending request; invalidations during a render request a
 * subsequent frame. There is no timer, frequency cap, or message filtering.
 */
export class RenderScheduler {
  #render: () => void;
  #requestFrame: (callback: FrameRequestCallback) => number;
  #cancelFrame: (handle: number) => void;
  #pendingFrame: number | undefined;
  #rendering = false;
  #disposed = false;

  public constructor(
    render: () => void,
    requestFrame: (callback: FrameRequestCallback) => number = (callback) =>
      requestAnimationFrame(callback),
    cancelFrame: (handle: number) => void = (handle) => {
      cancelAnimationFrame(handle);
    },
  ) {
    this.#render = render;
    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
  }

  public queue(): void {
    if (this.#disposed || this.#pendingFrame != undefined) {
      return;
    }
    this.#pendingFrame = this.#requestFrame(this.#onAnimationFrame);
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
  }
}
