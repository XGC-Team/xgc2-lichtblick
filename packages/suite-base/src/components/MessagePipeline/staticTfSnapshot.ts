// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { MessageEvent } from "@lichtblick/suite";

// A TFMessage is a partial update, including for ROS's latched /tf_static:
// each publisher owns a separate latched message. Keep one latest transform
// per child, with a hard limit on both frame count and retained payload size.
const MAX_FRAMES = 4096;
const MAX_BYTES = 16 * 1024 * 1024;

type Entry = { transform: unknown; bytes: number };

export class StaticTfSnapshot {
  #frames = new Map<string, Entry>();
  #bytes = 0;
  #latest?: MessageEvent;
  #overflowed = false;

  public clear(): void {
    this.#frames.clear();
    this.#bytes = 0;
    this.#latest = undefined;
    this.#overflowed = false;
  }

  public add(event: MessageEvent): void {
    if (this.#overflowed) {
      return;
    }
    const message = event.message as { transforms?: unknown } | undefined;
    if (
      !message ||
      !Array.isArray(message.transforms) ||
      !Number.isSafeInteger(event.sizeInBytes) ||
      event.sizeInBytes < 0
    ) {
      this.#invalidate();
      return;
    }
    for (const transform of message.transforms as unknown[]) {
      const child = (transform as { child_frame_id?: unknown } | undefined)?.child_frame_id;
      if (typeof child !== "string" || child.length === 0) {
        this.#invalidate();
        return;
      }
      // ROS frame lookup treats a single leading slash as an alias.
      const key = child.startsWith("/") ? child.slice(1) : child;
      if (key.length === 0) {
        this.#invalidate();
        return;
      }
      const old = this.#frames.get(key);
      // Charging the full message to each child is intentionally conservative.
      const bytes = Math.max(event.sizeInBytes, 1);
      const total = this.#bytes - (old?.bytes ?? 0) + bytes;
      if (total > MAX_BYTES || (!old && this.#frames.size >= MAX_FRAMES)) {
        this.#invalidate();
        return;
      }
      this.#bytes = total;
      this.#frames.set(key, { transform, bytes });
    }
    this.#latest = event;
  }

  public event(): MessageEvent | undefined {
    if (!this.#latest || this.#overflowed) {
      return undefined;
    }
    return {
      ...this.#latest,
      sizeInBytes: this.#bytes,
      message: {
        ...(this.#latest.message as object),
        transforms: Array.from(this.#frames.values(), (entry) => entry.transform),
      },
    };
  }

  #invalidate(): void {
    this.clear();
    this.#overflowed = true;
  }
}
