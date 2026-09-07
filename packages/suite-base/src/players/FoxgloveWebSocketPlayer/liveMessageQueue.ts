// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/**
 * Queue entries with inter-frame dependencies cannot be thinned one message at a time. If any
 * delta frame is discarded, every following delta frame in that GOP is undecodable too.
 */
export type LiveMessageRetention = "replaceable" | "protected" | "video";
export type ProtectedMessagePriority = "normal" | "high" | "critical";

type LiveMessageQueueEntry<T> = {
  value: T;
  sizeInBytes: number;
  /**
   * Stable stream identity. Replaceable entries with the same key may supersede each other; video
   * entries with the same key belong to one inter-frame dependency chain.
   */
  key?: string;
  retention: LiveMessageRetention;
  /**
   * Used only for protected traffic. High-priority entries (for example /tf_static) outlive normal
   * transforms. Critical entries (protocol control) are the final eviction tier, but are still
   * discarded oldest-first if that is the only way to preserve the hard memory bound.
   */
  protectedPriority?: ProtectedMessagePriority;
  /** True when this video message can restart decoding without earlier frames in the GOP. */
  isVideoRecoveryPoint?: boolean;
};

type LiveMessageEnqueueResult = {
  accepted: boolean;
  droppedEntries: number;
  /** Present when protocol-critical protected entries were dropped. */
  droppedCriticalEntries?: number;
  /** True when the incoming entry (or its indivisible video chain) could not fit under the cap. */
  sizeLimitExceeded: boolean;
};

type TrimPlan<T> = {
  criticalEntriesDropped: number;
  droppedEntries: number;
  entries: LiveMessageQueueEntry<T>[];
  sizeInBytes: bigint;
  videoStreamsAwaitingRecovery: Set<string>;
};

/**
 * A memory-bounded live queue which understands inter-frame video dependencies.
 *
 * Ordinary telemetry can optionally be superseded by stream key. Protected messages (notably
 * transforms) remain ordered while capacity permits. Under pressure the queue evicts replaceable
 * telemetry first, complete video dependency chains second, normal protected traffic third, and
 * high-priority protected traffic next, and protocol-critical traffic last. Video is never thinned
 * frame-by-frame: the queue either keeps a suffix beginning at a newer recovery point, or discards
 * the whole queued chain and rejects delta frames until the next recovery point arrives.
 *
 * The sum of `sizeInBytes` for queued entries never exceeds `maximumSizeBytes`. An entry which is
 * individually larger than the cap is rejected without disturbing already queued entries.
 */
export class LiveMessageQueue<T> {
  // Removed slots release payloads immediately. Compact geometrically, not on every shift.
  #entries: (LiveMessageQueueEntry<T> | undefined)[] = [];
  readonly #replaceableEntriesByKey = new Map<string, Set<number>>();
  #head = 0;
  #entryCount = 0;
  readonly #videoStreamsAwaitingRecovery = new Set<string>();
  #maximumSizeBytes: number;
  #sizeInBytes = 0;

  public constructor(maximumSizeBytes: number) {
    LiveMessageQueue.#validateByteCount(maximumSizeBytes, "maximumSizeBytes");
    this.#maximumSizeBytes = maximumSizeBytes;
  }

  public setMaximumSize(maximumSizeBytes: number): number {
    LiveMessageQueue.#validateByteCount(maximumSizeBytes, "maximumSizeBytes");
    if (this.#sizeInBytes <= maximumSizeBytes) {
      this.#maximumSizeBytes = maximumSizeBytes;
      return 0;
    }
    const plan = this.#createTrimPlan(
      this.#snapshot(),
      BigInt(this.#sizeInBytes),
      maximumSizeBytes,
      new Set(this.#videoStreamsAwaitingRecovery),
    );

    // Keep the invariant true even during the synchronous commit: when growing, publish the larger
    // cap first; when shrinking, remove entries before publishing the smaller cap.
    if (maximumSizeBytes >= this.#maximumSizeBytes) {
      this.#maximumSizeBytes = maximumSizeBytes;
      this.#commitPlan(plan);
    } else {
      this.#commitPlan(plan);
      this.#maximumSizeBytes = maximumSizeBytes;
    }
    return plan.droppedEntries;
  }

  public getSizeInBytes(): number {
    return this.#sizeInBytes;
  }

  /** On-demand diagnostics; no payloads or mutable storage are exposed. */
  public getStorageStats(): {
    queuedEntries: number;
    allocatedSlots: number;
    replaceableKeys: number;
  } {
    return {
      queuedEntries: this.#entryCount,
      allocatedSlots: this.#entries.length,
      replaceableKeys: this.#replaceableEntriesByKey.size,
    };
  }

  public enqueue(
    entry: LiveMessageQueueEntry<T>,
    options: { supersedeReplaceable?: boolean } = {},
  ): LiveMessageEnqueueResult {
    LiveMessageQueue.#validateByteCount(entry.sizeInBytes, "entry.sizeInBytes");
    const videoKey =
      entry.retention === "video" && entry.key != undefined && entry.key.length > 0
        ? entry.key
        : undefined;

    if (entry.sizeInBytes > this.#maximumSizeBytes) {
      if (videoKey != undefined) {
        // This frame will be missing from the decoder input. Reject every following delta until a
        // complete, independently decodable recovery frame can fit in the queue.
        this.#videoStreamsAwaitingRecovery.add(videoKey);
      }
      return this.#enqueueResult({
        accepted: false,
        droppedEntries: 1,
        sizeLimitExceeded: true,
        droppedCriticalEntries:
          entry.retention === "protected" && entry.protectedPriority === "critical" ? 1 : 0,
      });
    }

    if (entry.retention === "video") {
      // Without a stable stream key there is no safe way to discard a complete dependency chain.
      if (videoKey == undefined) {
        return this.#enqueueResult({
          accepted: false,
          droppedEntries: 1,
          sizeLimitExceeded: false,
        });
      }

      if (this.#videoStreamsAwaitingRecovery.has(videoKey)) {
        if (entry.isVideoRecoveryPoint !== true) {
          return this.#enqueueResult({
            accepted: false,
            droppedEntries: 1,
            sizeLimitExceeded: false,
          });
        }
      }
    }

    // Admission without pressure is the common path. Looking up only the samples being
    // superseded avoids copying/scanning the whole queue for every incoming message.
    const supersededIndices =
      entry.retention === "replaceable" &&
      entry.key != undefined &&
      options.supersedeReplaceable === true
        ? this.#replaceableEntriesByKey.get(entry.key)
        : undefined;
    let supersededSize = 0;
    if (supersededIndices != undefined) {
      for (const index of supersededIndices) {
        supersededSize += this.#entries[index]!.sizeInBytes;
      }
    }
    // Subtract before comparing: adding two safe byte counts can overflow MAX_SAFE_INTEGER.
    if (entry.sizeInBytes <= this.#maximumSizeBytes - (this.#sizeInBytes - supersededSize)) {
      const droppedEntries = supersededIndices?.size ?? 0;
      if (supersededIndices != undefined) {
        for (const index of supersededIndices) {
          this.#removeAt(index);
        }
      }
      if (videoKey != undefined) {
        this.#videoStreamsAwaitingRecovery.delete(videoKey);
      }
      this.#append({ ...entry });
      this.#compact();
      return this.#enqueueResult({ accepted: true, droppedEntries, sizeLimitExceeded: false });
    }

    // With only normal protected entries, pressure eviction is exactly FIFO. Inspect in place
    // instead of allocating a detached snapshot and rebuilding every survivor. Keep mixed
    // retention/priority, video recovery and replaceable rollback on the planner below.
    if (
      entry.retention === "protected" &&
      entry.protectedPriority !== "high" &&
      entry.protectedPriority !== "critical" &&
      this.#hasOnlyNormalProtectedEntries()
    ) {
      return this.#enqueueNormalProtected(entry);
    }

    // Under pressure preserve the transactional eviction policy, including video dependency
    // chains, protected priority and rollback when a larger replacement cannot be admitted.
    const workingEntries = this.#snapshot();
    let workingSizeInBytes = BigInt(this.#sizeInBytes);
    const workingRecoveryState = new Set(this.#videoStreamsAwaitingRecovery);
    let supersededEntries = 0;
    if (
      entry.retention === "replaceable" &&
      entry.key != undefined &&
      options.supersedeReplaceable === true
    ) {
      for (let index = workingEntries.length - 1; index >= 0; index--) {
        const queued = workingEntries[index]!;
        if (queued.retention === "replaceable" && queued.key === entry.key) {
          workingEntries.splice(index, 1);
          workingSizeInBytes -= BigInt(queued.sizeInBytes);
          supersededEntries++;
        }
      }
    } else if (videoKey != undefined) {
      workingRecoveryState.delete(videoKey);
    }

    // Copy the entry so acceptance remains unambiguous even if a caller enqueues the same object
    // reference more than once. Planning happens on a detached array; the live queue is not
    // mutated (and therefore never transiently exceeds its cap) until a bounded result exists.
    const queuedEntry = { ...entry };
    workingEntries.push(queuedEntry);
    workingSizeInBytes += BigInt(queuedEntry.sizeInBytes);
    const plan = this.#createTrimPlan(
      workingEntries,
      workingSizeInBytes,
      this.#maximumSizeBytes,
      workingRecoveryState,
    );
    plan.droppedEntries += supersededEntries;
    const accepted = plan.entries.includes(queuedEntry);

    if (!accepted && entry.retention === "replaceable" && supersededEntries > 0) {
      // A larger replacement may lose to protected traffic. Preserve the still-valid older sample
      // instead of committing a supersession whose replacement could not be queued.
      return this.#enqueueResult({
        accepted: false,
        droppedEntries: 1,
        sizeLimitExceeded: true,
      });
    }

    this.#commitPlan(plan);
    return this.#enqueueResult({
      accepted,
      droppedEntries: plan.droppedEntries,
      sizeLimitExceeded: !accepted,
      droppedCriticalEntries: plan.criticalEntriesDropped,
    });
  }

  public shift(): LiveMessageQueueEntry<T> | undefined {
    while (this.#head < this.#entries.length) {
      const index = this.#head++;
      const entry = this.#entries[index];
      if (entry != undefined) {
        this.#removeAt(index);
        this.#compact();
        return entry;
      }
    }
    return undefined;
  }

  /** Drain queued values while retaining per-video recovery state established by prior drops. */
  public drain(): T[] {
    const values: T[] = [];
    for (let index = this.#head; index < this.#entries.length; index++) {
      const entry = this.#entries[index];
      if (entry != undefined) {
        values.push(entry.value);
      }
    }
    this.#resetEntries();
    return values;
  }

  /** Reset both queued data and dependency state, e.g. for a new connection or a time seek. */
  public clear(): void {
    this.#resetEntries();
    this.#videoStreamsAwaitingRecovery.clear();
  }

  /** Remove queued entries and dependency state for a subscription which no longer exists. */
  public removeKey(key: string): number {
    let removedEntries = 0;
    for (let index = this.#head; index < this.#entries.length; index++) {
      if (this.#entries[index]?.key === key) {
        this.#removeAt(index);
        removedEntries++;
      }
    }
    this.#compact();
    this.#videoStreamsAwaitingRecovery.delete(key);
    return removedEntries;
  }

  #append(entry: LiveMessageQueueEntry<T>): void {
    const index = this.#entries.length;
    this.#entries.push(entry);
    this.#entryCount++;
    this.#sizeInBytes += entry.sizeInBytes;
    if (entry.retention === "replaceable" && entry.key != undefined) {
      let indices = this.#replaceableEntriesByKey.get(entry.key);
      if (indices == undefined) {
        indices = new Set();
        this.#replaceableEntriesByKey.set(entry.key, indices);
      }
      indices.add(index);
    }
  }

  #removeAt(index: number): void {
    const entry = this.#entries[index];
    if (entry == undefined) {
      return;
    }
    this.#entries[index] = undefined;
    this.#entryCount--;
    this.#sizeInBytes -= entry.sizeInBytes;
    if (entry.retention === "replaceable" && entry.key != undefined) {
      const indices = this.#replaceableEntriesByKey.get(entry.key);
      indices?.delete(index);
      if (indices?.size === 0) {
        this.#replaceableEntriesByKey.delete(entry.key);
      }
    }
  }

  #enqueueNormalProtected(entry: LiveMessageQueueEntry<T>): LiveMessageEnqueueResult {
    // Copy before mutation. Subtract before comparing to avoid adding safe byte counts
    // whose sum could exceed MAX_SAFE_INTEGER. Oversized entries were already rejected.
    const queuedEntry = { ...entry };
    const targetSize = this.#maximumSizeBytes - queuedEntry.sizeInBytes;
    let droppedEntries = 0;
    while (this.#sizeInBytes > targetSize) {
      const index = this.#head++;
      if (this.#entries[index] != undefined) {
        this.#removeAt(index);
        droppedEntries++;
      }
    }
    this.#append(queuedEntry);
    this.#compact();
    return this.#enqueueResult({ accepted: true, droppedEntries, sizeLimitExceeded: false });
  }

  #hasOnlyNormalProtectedEntries(): boolean {
    for (let index = this.#head; index < this.#entries.length; index++) {
      const entry = this.#entries[index];
      if (
        entry != undefined &&
        (entry.retention !== "protected" ||
          entry.protectedPriority === "high" ||
          entry.protectedPriority === "critical")
      ) {
        return false;
      }
    }
    return true;
  }

  #snapshot(): LiveMessageQueueEntry<T>[] {
    if (this.#entryCount === this.#entries.length - this.#head) {
      // A dense suffix needs no per-slot filtering. The detached copy still owns the plan.
      return this.#entries.slice(this.#head) as LiveMessageQueueEntry<T>[];
    }
    const entries: LiveMessageQueueEntry<T>[] = [];
    for (let index = this.#head; index < this.#entries.length; index++) {
      const entry = this.#entries[index];
      if (entry != undefined) {
        entries.push(entry);
      }
    }
    return entries;
  }

  #resetEntries(): void {
    this.#entries.length = 0;
    this.#head = 0;
    this.#entryCount = 0;
    this.#sizeInBytes = 0;
    this.#replaceableEntriesByKey.clear();
  }

  #compact(): void {
    if (this.#entryCount === 0) {
      this.#resetEntries();
    } else if (this.#entries.length > 1024 && this.#entries.length > this.#entryCount * 2) {
      const entries = this.#snapshot();
      this.#resetEntries();
      for (const entry of entries) {
        this.#append(entry);
      }
    }
  }

  #createTrimPlan(
    entries: LiveMessageQueueEntry<T>[],
    initialSizeInBytes: bigint,
    maximumSizeBytes: number,
    videoStreamsAwaitingRecovery: Set<string>,
  ): TrimPlan<T> {
    let droppedEntries = 0;
    let criticalEntriesDropped = 0;
    let sizeInBytes = initialSizeInBytes;
    const maximumSize = BigInt(maximumSizeBytes);
    const removeAt = (index: number): void => {
      const [removed] = entries.splice(index, 1);
      if (removed == undefined) {
        return;
      }
      sizeInBytes -= BigInt(removed.sizeInBytes);
      droppedEntries++;
      if (removed.retention === "protected" && removed.protectedPriority === "critical") {
        criticalEntriesDropped++;
      }
    };
    const removeWhere = (
      predicate: (queued: LiveMessageQueueEntry<T>, index: number) => boolean,
    ): void => {
      for (let index = entries.length - 1; index >= 0; index--) {
        if (predicate(entries[index]!, index)) {
          removeAt(index);
        }
      }
    };

    while (sizeInBytes > maximumSize) {
      const replaceableIndex = entries.findIndex((entry) => entry.retention === "replaceable");
      if (replaceableIndex >= 0) {
        removeAt(replaceableIndex);
        continue;
      }

      const oldestVideo = entries.find((entry) => entry.retention === "video");
      if (oldestVideo?.key != undefined) {
        const streamKey = oldestVideo.key;
        const firstStreamIndex = entries.findIndex(
          (entry) => entry.retention === "video" && entry.key === streamKey,
        );
        let latestRecoveryIndex = -1;
        for (let i = firstStreamIndex + 1; i < entries.length; i++) {
          const entry = entries[i]!;
          if (
            entry.retention === "video" &&
            entry.key === streamKey &&
            entry.isVideoRecoveryPoint === true
          ) {
            latestRecoveryIndex = i;
          }
        }

        if (latestRecoveryIndex >= 0) {
          // A newer independently decodable GOP is already queued. Discard only older frames from
          // this stream and retain the recovery point plus every dependent frame after it.
          removeWhere(
            (entry, index) =>
              index < latestRecoveryIndex && entry.retention === "video" && entry.key === streamKey,
          );
        } else {
          // There is no newer recovery point in the queue. Removing any one frame would invalidate
          // the remainder, so discard the complete queued chain and fail closed until the next
          // random-access frame carrying fresh decoder parameter sets.
          removeWhere((entry) => entry.retention === "video" && entry.key === streamKey);
          videoStreamsAwaitingRecovery.add(streamKey);
        }
        continue;
      }

      const normalProtectedIndex = entries.findIndex(
        (entry) =>
          entry.retention === "protected" &&
          entry.protectedPriority !== "high" &&
          entry.protectedPriority !== "critical",
      );
      if (normalProtectedIndex >= 0) {
        removeAt(normalProtectedIndex);
        continue;
      }

      const highProtectedIndex = entries.findIndex(
        (entry) => entry.retention === "protected" && entry.protectedPriority === "high",
      );
      if (highProtectedIndex >= 0) {
        removeAt(highProtectedIndex);
        continue;
      }

      // Only protocol-critical traffic remains. The hard bound takes precedence even here.
      removeAt(0);
    }

    return {
      criticalEntriesDropped,
      droppedEntries,
      entries,
      sizeInBytes,
      videoStreamsAwaitingRecovery,
    };
  }

  #commitPlan(plan: TrimPlan<T>): void {
    // The planner owns this detached, dense array and never exposes it to callers. Adopt it
    // instead of copying every survivor through #append. The bounded bigint total is exact.
    this.#entries = plan.entries;
    this.#head = 0;
    this.#entryCount = plan.entries.length;
    this.#sizeInBytes = Number(plan.sizeInBytes);
    this.#replaceableEntriesByKey.clear();
    for (let index = 0; index < plan.entries.length; index++) {
      const entry = plan.entries[index]!;
      if (entry.retention === "replaceable" && entry.key != undefined) {
        let indices = this.#replaceableEntriesByKey.get(entry.key);
        if (indices == undefined) {
          indices = new Set();
          this.#replaceableEntriesByKey.set(entry.key, indices);
        }
        indices.add(index);
      }
    }
    this.#videoStreamsAwaitingRecovery.clear();
    for (const key of plan.videoStreamsAwaitingRecovery) {
      this.#videoStreamsAwaitingRecovery.add(key);
    }
  }

  #enqueueResult(options: {
    accepted: boolean;
    droppedCriticalEntries?: number;
    droppedEntries: number;
    sizeLimitExceeded: boolean;
  }): LiveMessageEnqueueResult {
    return {
      accepted: options.accepted,
      droppedEntries: options.droppedEntries,
      ...(options.droppedCriticalEntries != undefined && options.droppedCriticalEntries > 0
        ? { droppedCriticalEntries: options.droppedCriticalEntries }
        : {}),
      sizeLimitExceeded: options.sizeLimitExceeded,
    };
  }

  static #validateByteCount(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
}

/**
 * Recognize transform-bearing schemas independently of their topic name. This covers ROS 1/2,
 * protobuf-style ROS names, Foxglove frame-transform schemas, and equivalent custom packages whose
 * leaf type preserves the standard semantic name.
 */
export function isTransformSchemaName(schemaName: string | undefined): boolean {
  if (schemaName == undefined) {
    return false;
  }
  const leaf = schemaName.split(/[./:]/).filter(Boolean).at(-1);
  return (
    leaf === "TFMessage" ||
    leaf === "tfMessage" ||
    leaf === "TransformStamped" ||
    leaf === "FrameTransform" ||
    leaf === "FrameTransforms"
  );
}

type AnnexBVideoFrameInfo = {
  hasParameterSet: boolean;
  isRecoveryPoint: boolean;
};

/**
 * Inspect an Annex-B H.264/H.265 access unit without deserializing its surrounding ROS message.
 * Emulation-prevention rules guarantee that start codes do not occur inside a NAL payload.
 */
export function inspectAnnexBVideoFrame(data: Uint8Array): AnnexBVideoFrameInfo {
  let hasH264Idr = false;
  let hasH264Sps = false;
  let hasH264Pps = false;
  let hasH265Irap = false;
  let hasH265Vps = false;
  let hasH265Sps = false;
  let hasH265Pps = false;

  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) {
      continue;
    }

    let headerIndex: number;
    if (data[i + 2] === 1) {
      headerIndex = i + 3;
    } else if (i + 4 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
      headerIndex = i + 4;
    } else {
      continue;
    }

    const header = data[headerIndex];
    if (header == undefined) {
      break;
    }

    const h264Type = header & 0x1f;
    hasH264Idr ||= h264Type === 5;
    hasH264Sps ||= h264Type === 7;
    hasH264Pps ||= h264Type === 8;

    const h265Type = (header >> 1) & 0x3f;
    hasH265Irap ||= h265Type >= 16 && h265Type <= 23;
    hasH265Vps ||= h265Type === 32;
    hasH265Sps ||= h265Type === 33;
    hasH265Pps ||= h265Type === 34;

    i = headerIndex;
  }

  const hasH264ParameterSet = hasH264Sps && hasH264Pps;
  const hasH265ParameterSet = hasH265Vps && hasH265Sps && hasH265Pps;
  const isH264 = hasH264Idr || hasH264Sps || hasH264Pps;
  const isH265 = hasH265Irap || hasH265Vps || hasH265Sps || hasH265Pps;
  return {
    hasParameterSet: (isH264 && hasH264ParameterSet) || (isH265 && hasH265ParameterSet),
    // A recovery point must carry both random-access picture data and decoder parameter sets.
    // This lets a fresh/reset decoder restart too, rather than relying on configuration which may
    // have belonged to the discarded GOP.
    isRecoveryPoint:
      (isH264 && hasH264Idr && hasH264ParameterSet) ||
      (isH265 && hasH265Irap && hasH265ParameterSet),
  };
}
