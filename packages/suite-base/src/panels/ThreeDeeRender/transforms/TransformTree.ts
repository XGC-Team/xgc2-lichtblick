// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ObjectPool } from "@lichtblick/den/collection";

import { CoordinateFrame, FallbackFrameId, AnyFrameId } from "./CoordinateFrame";
import { Transform } from "./Transform";
import { Pose } from "./geometry";
import { Duration, Time } from "./time";

/**
 * XGC2 is a live robotics display. Keeping minutes of TF history in every 3D
 * panel makes the browser retain millions of transforms without improving the
 * current view, so the default history is intentionally short and bounded.
 *
 * 256 samples preserve the full two-second window up to ~100 Hz publication
 * rates (capacity trims fire at `size >= max`, evicting the oldest 25%, so the
 * capacity must exceed rate x window to let the time bound govern). Static
 * transforms still occupy a single entry.
 *
 * Deployments that need longer interpolation history (e.g. rosbag replay,
 * latency compensation debugging) can extend the window per page load with the
 * URL query parameter `xgcTfHistorySeconds` (1..600). Capacity scales with the
 * requested window at a 128 samples/second budget.
 * We store a history of transforms received so that Markers and other 3D elements
 * can reference the state of a CoordinateFrame transform at a particular time rather than
 * only storing the most recent frame.
 * Considerations for the setting of this value are:
 *  - the larger the value, the more memory is used per panel
 *  - the larger the value, the longer it can take to set transforms within the history
 *  - the larger the value, the more likely it is that objects will be able to reference transforms at older times.
 *    Note that this is highly dependent on the frequency transforms for a given frame are published.
 *    For example, for 50Hz transforms for a single frame and a value of 5,000 max capacity. The transform
 *    history will contain 100 seconds of history for this frame.
 *    For 1kHz transforms for a single frame and a value of 5,000 max capacity. The transform history would
 *    only store 5 seconds of history for this frame.
 *    If the object references a transform at a time older than the history, it will simply use the oldest transform for that frame
 *    which is not guaranteed to be accurate.
 *
 * Callers that explicitly need playback history can still construct a
 * `TransformTree` with larger values.
 */
export const DEFAULT_MAX_CAPACITY_PER_FRAME = 256;
export const DEFAULT_MAX_STORAGE_TIME = 2n * BigInt(1e9);

const TF_HISTORY_SAMPLES_PER_SECOND = 128;
const TF_HISTORY_SECONDS_MIN = 1;
const TF_HISTORY_SECONDS_MAX = 600;

export type LiveTfHistoryConfig = {
  maxStorageTime: Duration;
  maxCapacityPerFrame: number;
};

/**
 * Resolve the live TF history bounds from a URL query string. An absent or
 * invalid `xgcTfHistorySeconds` yields the bounded defaults; a valid value
 * (clamped to 1..600 s) extends the window and scales the per-frame capacity
 * at 128 samples/second so the time bound, not the capacity trim, governs.
 */
export function resolveLiveTfHistory(search: string | undefined): LiveTfHistoryConfig {
  const defaults: LiveTfHistoryConfig = {
    maxStorageTime: DEFAULT_MAX_STORAGE_TIME,
    maxCapacityPerFrame: DEFAULT_MAX_CAPACITY_PER_FRAME,
  };
  if (search == undefined || search === "") {
    return defaults;
  }
  let raw: string | null;
  try {
    raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(
      "xgcTfHistorySeconds",
    );
  } catch {
    return defaults;
  }
  if (raw == undefined || raw === "") {
    return defaults;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < TF_HISTORY_SECONDS_MIN) {
    return defaults;
  }
  const clamped = Math.min(seconds, TF_HISTORY_SECONDS_MAX);
  return {
    maxStorageTime: BigInt(Math.round(clamped * 1e9)),
    maxCapacityPerFrame: Math.max(
      DEFAULT_MAX_CAPACITY_PER_FRAME,
      Math.ceil(clamped * TF_HISTORY_SAMPLES_PER_SECOND),
    ),
  };
}

const liveTfHistory = resolveLiveTfHistory(
  (globalThis as { location?: { search?: string } }).location?.search,
);

export enum AddTransformResult {
  NOT_UPDATED,
  UPDATED,
  CYCLE_DETECTED,
}

// Coordinate frames named in [REP-105](https://www.ros.org/reps/rep-0105.html)
const DEFAULT_FRAME_IDS = ["base_link", "odom", "map", "earth"];

/**
 * TransformTree is a collection of coordinate frames with convenience methods
 * for getting and creating frames and adding transforms between frames.
 */
export class TransformTree {
  #frames = new Map<string, CoordinateFrame>();
  #maxStorageTime: Duration;
  #maxCapacityPerFrame: number;
  #transformPool: ObjectPool<Transform>;

  public defaultRootFrame: CoordinateFrame<FallbackFrameId>;

  public constructor(
    transformPool: ObjectPool<Transform>,
    maxStorageTime = liveTfHistory.maxStorageTime,
    maxCapacityPerFrame = liveTfHistory.maxCapacityPerFrame,
  ) {
    this.#transformPool = transformPool;
    this.#maxStorageTime = maxStorageTime;
    this.#maxCapacityPerFrame = maxCapacityPerFrame;
    this.defaultRootFrame = new CoordinateFrame(
      CoordinateFrame.FALLBACK_FRAME_ID,
      undefined,
      this.#maxStorageTime,
      this.#maxCapacityPerFrame,
      this.#transformPool,
    );
    this.defaultRootFrame.addTransform(0n, Transform.Identity());
  }

  public addTransform(
    frameId: string,
    parentFrameId: string,
    time: Time,
    transform: Transform,
  ): AddTransformResult {
    let updated = !this.hasFrame(frameId);
    let cycleDetected = false;
    const frame = this.getOrCreateFrame(frameId);
    const curParentFrame = frame.parent();
    if (curParentFrame?.id !== parentFrameId) {
      cycleDetected = this.#checkParentForCycle(frameId, parentFrameId);
      // This frame was previously unparented but now we know its parent, or we
      // are reparenting this frame
      if (!cycleDetected) {
        frame.setParent(this.getOrCreateFrame(parentFrameId));
        updated = true;
      }
    }

    if (!cycleDetected) {
      frame.addTransform(time, transform);
    }

    return cycleDetected
      ? AddTransformResult.CYCLE_DETECTED
      : updated
        ? AddTransformResult.UPDATED
        : AddTransformResult.NOT_UPDATED;
  }

  /**
   * Removes transform data from a particular parent-child link at the given timestamp. Does nothing
   * if the child does not exist or has a different parent.
   */
  public removeTransform(childFrameId: string, parentFrameId: string, stamp: bigint): void {
    const child = this.frame(childFrameId);
    if (!child) {
      return;
    }
    if (child.parent()?.id !== parentFrameId) {
      return;
    }
    child.removeTransformAt(stamp);
    this.#removeEmptyAncestors(child);
  }

  /**
   * Walk up the tree starting from `candidate` and prune frames with no history entries and no
   * children.
   */
  #removeEmptyAncestors(candidate: CoordinateFrame): void {
    if (candidate.transformsSize() > 0) {
      // don't want to delete this frame, it is not empty
      return;
    }

    // Build a list of children for each frame in the tree, used to check whether nodes are leaf
    // nodes
    const childrenByParentId = new Map<string, Set<string>>();
    for (const frame of this.#frames.values()) {
      childrenByParentId.set(frame.id, new Set());
    }
    for (const frame of this.#frames.values()) {
      const parent = frame.parent();
      if (parent === candidate) {
        // can't delete this frame or its ancestors, it still has children
        return;
      }
      if (parent == undefined) {
        continue;
      }
      const children = childrenByParentId.get(parent.id);
      if (!children) {
        throw new Error("invariant: should have children array");
      }
      children.add(frame.id);
    }

    // Walk upwards, deleting nodes with no history entries and no children
    for (
      let current: typeof candidate | undefined = candidate;
      current;
      current = current.parent()
    ) {
      if (current.transformsSize() > 0) {
        // don't want to delete this frame, it is not empty
        return;
      }
      const children = childrenByParentId.get(current.id);
      if (children && children.size > 0) {
        // can't delete this frame or its ancestors, it still has children
        return;
      }
      this.#frames.delete(current.id);
      childrenByParentId.delete(current.id);
      const parentId = current.parent()?.id;
      if (parentId) {
        childrenByParentId.get(parentId)?.delete(current.id);
      }
    }
  }

  public clear(): void {
    this.#frames.clear();
  }

  public clearAfter(time: Time): void {
    for (const frame of this.#frames.values()) {
      frame.removeTransformsAfter(time);
    }
  }

  public hasFrame(id: AnyFrameId): boolean {
    if (id === CoordinateFrame.FALLBACK_FRAME_ID) {
      return true;
    }
    return this.#frames.has(id);
  }

  public frame<ID extends AnyFrameId>(id: ID): CoordinateFrame<ID> | undefined {
    if (id === CoordinateFrame.FALLBACK_FRAME_ID) {
      return this.defaultRootFrame as CoordinateFrame<ID>;
    }
    return this.#frames.get(id) as CoordinateFrame<ID>;
  }

  public getOrCreateFrame(id: string): CoordinateFrame {
    let frame = this.#frames.get(id);
    if (!frame) {
      frame = new CoordinateFrame(
        id,
        undefined,
        this.#maxStorageTime,
        this.#maxCapacityPerFrame,
        this.#transformPool,
      );
      this.#frames.set(id, frame);
    }
    return frame;
  }

  public frames(): ReadonlyMap<string, CoordinateFrame> {
    return this.#frames;
  }

  public apply(
    output: Pose,
    input: Readonly<Pose>,
    frameId: AnyFrameId,
    rootFrameId: AnyFrameId | undefined,
    srcFrameId: AnyFrameId,
    dstTime: Time,
    srcTime: Time,
    maxDelta?: Duration,
  ): Pose | undefined {
    const frame = this.frame(frameId);
    const srcFrame = this.frame(srcFrameId);
    if (!frame || !srcFrame) {
      return undefined;
    }
    const rootFrame =
      (rootFrameId != undefined ? this.frame(rootFrameId) : frame.root()) ?? frame.root();
    return frame.apply(output, input, rootFrame, srcFrame, dstTime, srcTime, maxDelta);
  }

  public frameList(): { label: string; value: string }[] {
    type FrameEntry = { id: string; children: FrameEntry[] };

    const frames = Array.from(this.#frames.values());
    const frameMap = new Map<string, FrameEntry>(
      frames.map((frame) => [frame.id, { id: frame.id, children: [] }]),
    );

    // Create a hierarchy of coordinate frames
    const rootFrames: FrameEntry[] = [];
    for (const frame of frames) {
      const frameEntry = frameMap.get(frame.id)!;
      const parentId = frame.parent()?.id;
      if (parentId == undefined) {
        rootFrames.push(frameEntry);
      } else {
        const parent = frameMap.get(parentId);
        if (parent == undefined) {
          continue;
        }
        parent.children.push(frameEntry);
      }
    }

    // Convert the `rootFrames` hierarchy into a flat list of coordinate frames with depth
    const output: { label: string; value: string }[] = [];

    function addFrame(frame: FrameEntry, depth: number) {
      const displayName = CoordinateFrame.DisplayName(frame.id);
      output.push({
        value: frame.id,
        label: `${"\u00A0\u00A0".repeat(depth)}${displayName}`,
      });
      frame.children.sort((a, b) => a.id.localeCompare(b.id));
      for (const child of frame.children) {
        addFrame(child, depth + 1);
      }
    }

    rootFrames.sort((a, b) => a.id.localeCompare(b.id));
    for (const entry of rootFrames) {
      addFrame(entry, 0);
    }

    return output;
  }

  /** Get heuristically most valid follow frame Id */
  public getDefaultFollowFrameId(): string | undefined {
    const allFrames = this.frames();
    if (allFrames.size === 0) {
      return undefined;
    }

    // Prefer frames from [REP-105](https://www.ros.org/reps/rep-0105.html)
    for (const frameId of DEFAULT_FRAME_IDS) {
      const frame = this.frame(frameId);
      if (frame) {
        return frame.id;
      }
    }

    // Choose the root frame with the most children
    const rootsToCounts = new Map<string, number>();
    for (const frame of allFrames.values()) {
      const root = frame.root();
      const rootId = root.id;

      rootsToCounts.set(rootId, (rootsToCounts.get(rootId) ?? 0) + 1);
    }
    const rootsArray = Array.from(rootsToCounts.entries());
    const rootId = rootsArray.sort((a, b) => b[1] - a[1])[0]?.[0];
    return rootId;
  }

  #checkParentForCycle(frameId: string, parentFrameId: string): boolean {
    if (frameId === parentFrameId) {
      return true;
    }
    // walk up tree from parent Frame to check if it eventually crosses the frame
    let frame = this.frame(parentFrameId);
    while (frame?.parent()) {
      if (frame.parent()?.id === frameId) {
        return true;
      }
      frame = frame.parent();
    }
    return false;
  }

  public static Clone(tree: TransformTree): TransformTree {
    const newTree = new TransformTree(
      tree.#transformPool,
      tree.#maxStorageTime,
      tree.#maxCapacityPerFrame,
    );
    newTree.#frames = tree.#frames;
    return newTree;
  }
}
