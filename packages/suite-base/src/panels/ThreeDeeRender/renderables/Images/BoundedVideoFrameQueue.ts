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
  readonly #entries: VideoFrameQueueEntry<T>[] = [];
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

    if (this.#maximumFrames === 0 || entry.sizeInBytes > this.#maximumBytes) {
      const droppedEntries = this.#entries.length + 1;
      this.#clearEntries();
      this.#awaitingRecovery = true;
      return { accepted: false, droppedEntries, resetRequired: true };
    }

    const queuedEntry = { ...entry };
    const candidates = [...this.#entries, queuedEntry];
    const candidateBytes = BigInt(this.#sizeInBytes) + BigInt(entry.sizeInBytes);
    if (candidates.length <= this.#maximumFrames && candidateBytes <= BigInt(this.#maximumBytes)) {
      this.#commit(candidates, candidateBytes);
      if (entry.isRecoveryPoint) {
        this.#awaitingRecovery = false;
      }
      return { accepted: true, droppedEntries: 0, resetRequired: false };
    }

    let latestRecoveryIndex = -1;
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (candidates[index]?.isRecoveryPoint === true) {
        latestRecoveryIndex = index;
        break;
      }
    }
    if (latestRecoveryIndex >= 0) {
      const suffix = candidates.slice(latestRecoveryIndex);
      const suffixBytes = suffix.reduce(
        (total, candidate) => total + BigInt(candidate.sizeInBytes),
        0n,
      );
      if (suffix.length <= this.#maximumFrames && suffixBytes <= BigInt(this.#maximumBytes)) {
        this.#commit(suffix, suffixBytes);
        this.#awaitingRecovery = false;
        return {
          accepted: suffix.includes(queuedEntry),
          droppedEntries: latestRecoveryIndex,
          resetRequired: latestRecoveryIndex > 0,
        };
      }
    }

    const droppedEntries = candidates.length;
    this.#clearEntries();
    this.#awaitingRecovery = true;
    return { accepted: false, droppedEntries, resetRequired: true };
  }

  public shift(): T | undefined {
    const entry = this.#entries.shift();
    if (entry == undefined) {
      return undefined;
    }
    this.#sizeInBytes -= entry.sizeInBytes;
    return entry.value;
  }

  public clear(options: { awaitRecovery?: boolean } = {}): number {
    const droppedEntries = this.#entries.length;
    this.#clearEntries();
    this.#awaitingRecovery = options.awaitRecovery === true;
    return droppedEntries;
  }

  public getLength(): number {
    return this.#entries.length;
  }

  public getSizeInBytes(): number {
    return this.#sizeInBytes;
  }

  public isAwaitingRecovery(): boolean {
    return this.#awaitingRecovery;
  }

  #clearEntries(): void {
    this.#entries.length = 0;
    this.#sizeInBytes = 0;
  }

  #commit(entries: VideoFrameQueueEntry<T>[], sizeInBytes: bigint): void {
    this.#entries.length = 0;
    for (const entry of entries) {
      this.#entries.push(entry);
    }
    this.#sizeInBytes = Number(sizeInBytes);
  }

  static #validateLimit(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
}
