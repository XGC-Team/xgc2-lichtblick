// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

type VideoFrameQueueEntry<T> = {
  isRecoveryPoint: boolean;
  sizeInBytes: number;
  value: T;
};

export type VideoFrameQueueEnqueueResult = {
  accepted: boolean;
  droppedEntries: number;
  /**
   * The consumer's dependency state is no longer usable. It must reset before consuming the
   * retained recovery-point suffix, or remain reset while the queue awaits a future recovery.
   */
  resetRequired: boolean;
};

/**
 * A single-stream, frame-count and byte-bounded queue for inter-frame compressed video.
 *
 * When either limit is reached, the queue keeps only a suffix beginning at the newest complete
 * recovery point. If even that GOP cannot fit, the entire chain is discarded and delta frames are
 * rejected until a fitting recovery point arrives. It never returns a suffix beginning mid-GOP.
 */
export class BoundedVideoFrameQueue<T> {
  readonly #entries: (VideoFrameQueueEntry<T> | undefined)[] = [];
  #head = 0;
  #awaitingRecovery = false;
  readonly #maximumBytes: number;
  readonly #maximumFrames: number;
  #sizeInBytes = 0;

  public constructor(maximumFrames: number, maximumBytes: number) {
    BoundedVideoFrameQueue.#validateLimit(maximumFrames, "maximumFrames");
    BoundedVideoFrameQueue.#validateLimit(maximumBytes, "maximumBytes");
    this.#maximumFrames = maximumFrames;
    this.#maximumBytes = maximumBytes;
  }

  public enqueue(entry: VideoFrameQueueEntry<T>): VideoFrameQueueEnqueueResult {
    BoundedVideoFrameQueue.#validateLimit(entry.sizeInBytes, "entry.sizeInBytes");

    if (this.#awaitingRecovery && !entry.isRecoveryPoint) {
      return { accepted: false, droppedEntries: 1, resetRequired: false };
    }

    const length = this.getLength();
    if (this.#maximumFrames === 0 || entry.sizeInBytes > this.#maximumBytes) {
      const droppedEntries = length + 1;
      this.#clearEntries();
      this.#awaitingRecovery = true;
      return { accepted: false, droppedEntries, resetRequired: true };
    }

    const queuedEntry = { ...entry };
    // Common path: append once, not copy and rebuild the entire backlog on
    // every incoming frame. Subtract first to avoid unsafe-integer addition.
    if (
      length < this.#maximumFrames &&
      entry.sizeInBytes <= this.#maximumBytes - this.#sizeInBytes
    ) {
      this.#entries.push(queuedEntry);
      this.#sizeInBytes += entry.sizeInBytes;
      if (entry.isRecoveryPoint) {
        this.#awaitingRecovery = false;
      }
      return { accepted: true, droppedEntries: 0, resetRequired: false };
    }

    // Only pressure recovery scans a GOP. Search the incoming frame first;
    // consumed entries before #head must never be considered recovery anchors.
    let recoveryIndex = entry.isRecoveryPoint ? this.#entries.length : -1;
    if (recoveryIndex < 0) {
      for (let index = this.#entries.length - 1; index >= this.#head; index--) {
        if (this.#entries[index]?.isRecoveryPoint === true) {
          recoveryIndex = index;
          break;
        }
      }
    }
    if (recoveryIndex >= 0) {
      let suffixBytes = BigInt(entry.sizeInBytes);
      for (let index = recoveryIndex; index < this.#entries.length; index++) {
        suffixBytes += BigInt(this.#entries[index]!.sizeInBytes);
      }
      const suffixLength = this.#entries.length - recoveryIndex + 1;
      if (suffixLength <= this.#maximumFrames && suffixBytes <= BigInt(this.#maximumBytes)) {
        const droppedEntries = recoveryIndex - this.#head;
        this.#entries.splice(0, recoveryIndex);
        this.#head = 0;
        this.#entries.push(queuedEntry);
        this.#sizeInBytes = Number(suffixBytes);
        this.#awaitingRecovery = false;
        return { accepted: true, droppedEntries, resetRequired: droppedEntries > 0 };
      }
    }

    const droppedEntries = length + 1;
    this.#clearEntries();
    this.#awaitingRecovery = true;
    return { accepted: false, droppedEntries, resetRequired: true };
  }

  public shift(): T | undefined {
    const entry = this.#entries[this.#head];
    if (entry == undefined) {
      return undefined;
    }
    // Drop the payload reference immediately. Advancing a head index avoids
    // moving all remaining entries for every decoded frame.
    this.#entries[this.#head++] = undefined;
    this.#sizeInBytes -= entry.sizeInBytes;
    if (this.#head === this.#entries.length) {
      this.#clearEntries();
    } else if (this.#head >= 1024 && this.#head * 2 >= this.#entries.length) {
      this.#entries.splice(0, this.#head);
      this.#head = 0;
    }
    return entry.value;
  }

  public clear(options: { awaitRecovery?: boolean } = {}): number {
    const droppedEntries = this.getLength();
    this.#clearEntries();
    this.#awaitingRecovery = options.awaitRecovery === true;
    return droppedEntries;
  }

  public getLength(): number {
    return this.#entries.length - this.#head;
  }

  public getSizeInBytes(): number {
    return this.#sizeInBytes;
  }

  public isAwaitingRecovery(): boolean {
    return this.#awaitingRecovery;
  }

  #clearEntries(): void {
    this.#entries.length = 0;
    this.#head = 0;
    this.#sizeInBytes = 0;
  }

  static #validateLimit(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
}
