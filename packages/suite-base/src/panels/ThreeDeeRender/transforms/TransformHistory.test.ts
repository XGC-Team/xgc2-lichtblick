// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { mat4, quat, vec3 } from "gl-matrix";
import v8 from "node:v8";
import vm from "node:vm";

import { ArrayMap } from "@lichtblick/den/collection";

import { CoordinateFrame, MAX_CAPACITY_EVICT_PORTION, MAX_DURATION } from "./CoordinateFrame";
import { Transform } from "./Transform";
import { TransformHistory } from "./TransformHistory";
import { TransformTree } from "./TransformTree";
import { Duration, Time, percentOf } from "./time";

const SECOND = 1_000_000_000n;

/** Deterministic pseudo-random numbers, so a failure names a seed that replays. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The implementation this history replaced, kept as the reference the new one is compared against:
 * a sorted array of [time, Transform] with the capacity trim, lookup and interpolation as they were
 * in CoordinateFrame, and a chain walk as in GetTransformMatrix.
 */
class ReferenceFrame {
  public readonly transforms = new ArrayMap<Time, Transform>();
  public parent: ReferenceFrame | undefined;
  public offsetPosition: vec3 | undefined;
  public offsetEulerDegrees: vec3 | undefined;
  public version = 0;

  public constructor(
    public readonly id: string,
    public maxStorageTime: Duration,
    public maxCapacity: number,
  ) {}

  public setParent(parent: ReferenceFrame): void {
    if (this.parent && this.parent !== parent) {
      this.transforms.clear();
    }
    if (this.parent !== parent) {
      this.version++;
    }
    this.parent = parent;
  }

  public addTransform(time: Time, transform: Transform): void {
    this.transforms.set(time, transform);
    this.version++;
    if (this.transforms.size >= this.maxCapacity) {
      const removeBeforeIndex = Math.floor(this.maxCapacity * MAX_CAPACITY_EVICT_PORTION);
      let removeBeforeTime = this.transforms.at(removeBeforeIndex)![0];
      const endTime = this.transforms.maxKey()!;
      const startTime = endTime - this.maxStorageTime;
      removeBeforeTime = startTime > removeBeforeTime ? startTime : removeBeforeTime;
      this.transforms.removeBefore(removeBeforeTime);
    }
  }

  public removeAfter(time: Time): void {
    if (this.transforms.removeAfter(time).length > 0) {
      this.version++;
    }
  }

  public removeAt(time: Time): void {
    if (this.transforms.remove(time)) {
      this.version++;
    }
  }

  public findClosest(
    outLower: [Time, Transform],
    outUpper: [Time, Transform],
    time: Time,
    maxDelta: Duration,
  ): boolean {
    const count = this.transforms.size;
    if (count === 0) {
      return false;
    } else if (count === 1) {
      const [latestTime, latestTf] = this.transforms.maxEntry()!;
      if (time <= latestTime + maxDelta) {
        outLower[0] = outUpper[0] = latestTime;
        outLower[1] = outUpper[1] = latestTf;
        return true;
      }
      return false;
    }
    const index = this.transforms.binarySearch(time);
    if (index >= 0) {
      const [, tf] = this.transforms.at(index)!;
      outLower[0] = outUpper[0] = time;
      outLower[1] = outUpper[1] = tf;
      return true;
    }
    const greaterThanIndex = ~index;
    if (greaterThanIndex >= this.transforms.size) {
      const [latestTime, latestTf] = this.transforms.maxEntry()!;
      if (time <= latestTime + maxDelta) {
        outLower[0] = outUpper[0] = latestTime;
        outLower[1] = outUpper[1] = latestTf;
        return true;
      }
      return false;
    }
    const lessThanIndex = greaterThanIndex - 1;
    if (lessThanIndex < 0) {
      const [earliestTime, earliestTf] = this.transforms.minEntry()!;
      if (earliestTime + maxDelta >= time) {
        outLower[0] = outUpper[0] = earliestTime;
        outLower[1] = outUpper[1] = earliestTf;
        return true;
      }
      return false;
    }
    const [lteTime, lteTf] = this.transforms.at(lessThanIndex)!;
    const [gtTime, gtTf] = this.transforms.at(greaterThanIndex)!;
    outLower[0] = lteTime;
    outLower[1] = lteTf;
    outUpper[0] = gtTime;
    outUpper[1] = gtTf;
    return true;
  }
}

/** The XYZ Euler to quaternion conversion CoordinateFrame applies to a frame's rotation offset. */
function quaternionFromEulerDegrees(euler: vec3): quat {
  const toRadians = Math.PI / 180;
  const x = euler[0] * toRadians;
  const y = euler[1] * toRadians;
  const z = euler[2] * toRadians;
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function referenceMatrix(
  out: mat4,
  parent: ReferenceFrame,
  child: ReferenceFrame,
  time: Time,
  maxDelta: Duration,
): boolean {
  mat4.identity(out);
  const lower: [Time, Transform] = [0n, Transform.Identity()];
  const upper: [Time, Transform] = [0n, Transform.Identity()];
  const interpolated = Transform.Identity();
  let current = child;
  while (current !== parent) {
    if (!current.findClosest(lower, upper, time, maxDelta)) {
      return false;
    }
    if (lower[0] === upper[0]) {
      interpolated.copy(upper[1]);
    } else {
      const fraction = Math.max(0, Math.min(1, percentOf(lower[0], upper[0], time)));
      Transform.Interpolate(interpolated, lower[1], upper[1], fraction);
    }
    if (current.offsetEulerDegrees) {
      const offset = quaternionFromEulerDegrees(current.offsetEulerDegrees);
      interpolated.setRotation(quat.multiply([0, 0, 0, 1], interpolated.rotation(), offset));
    }
    if (current.offsetPosition) {
      const p = [...interpolated.position()] as vec3;
      vec3.add(p, p, current.offsetPosition);
      interpolated.setPosition(p);
    }
    mat4.multiply(out, interpolated.matrix(), out);
    current = current.parent!;
  }
  return true;
}

type Sample = { time: Time; position: vec3; rotation: quat };

function randomSample(rand: () => number, time: Time): Sample {
  return {
    time,
    position: [rand() * 20 - 10, rand() * 20 - 10, rand() * 4],
    // Deliberately not unit length: ingestion normalizes.
    rotation: [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() + 0.1],
  };
}

describe("TransformHistory", () => {
  const origin: vec3 = [0, 0, 0];
  const identity: quat = [0, 0, 0, 1];

  it("keeps samples ordered, replaces equal times and reports the same search results as ArrayMap", () => {
    const history = new TransformHistory();
    const reference = new ArrayMap<Time, number>();
    const rand = random(7);
    for (let i = 0; i < 400; i++) {
      const time = BigInt(Math.floor(rand() * 300)) * 10n;
      history.set(time, [i, 0, 0], identity);
      reference.set(time, i);
      expect(history.size).toBe(reference.size);
      for (const probe of [time, time + 5n, 0n, 3_005n]) {
        expect(history.binarySearch(probe)).toBe(reference.binarySearch(probe));
      }
    }
    const position: vec3 = [0, 0, 0];
    const rotation: quat = [0, 0, 0, 1];
    for (let i = 0; i < reference.size; i++) {
      const [time, value] = reference.at(i)!;
      expect(history.timeAt(i)).toBe(time);
      history.read(i, position, rotation);
      expect(position[0]).toBe(value);
    }
    expect(history.minKey()).toBe(reference.minKey());
    expect(history.maxKey()).toBe(reference.maxKey());
  });

  it("removes before, after and at a time exactly as ArrayMap does, across a wrapped buffer", () => {
    const rand = random(11);
    const history = new TransformHistory();
    const reference = new ArrayMap<Time, number>();
    for (let round = 0; round < 300; round++) {
      const time = BigInt(round * 10 + Math.floor(rand() * 8));
      history.set(time, origin, identity);
      reference.set(time, round);
      // Drop the oldest quarter now and then so the ring head keeps moving.
      const removed: [number, number][] = [];
      if (history.size > 40) {
        const cut = history.timeAt(10);
        removed.push([history.removeBefore(cut), reference.removeBefore(cut).length]);
      }
      if (round % 17 === 0) {
        const at = history.timeAt(Math.floor(history.size / 2));
        removed.push([Number(history.remove(at)), Number(reference.remove(at) != undefined)]);
      }
      if (round % 53 === 0) {
        const after = history.timeAt(history.size - 3);
        removed.push([history.removeAfter(after), reference.removeAfter(after).length]);
      }
      for (const [actual, wanted] of removed) {
        expect(actual).toBe(wanted);
      }
      expect(history.size).toBe(reference.size);
      for (let i = 0; i < reference.size; i++) {
        expect(history.timeAt(i)).toBe(reference.at(i)![0]);
      }
    }
    expect(history.clear()).toBe(reference.clear().length);
    expect(history.size).toBe(0);
    expect(history.minKey()).toBeUndefined();
  });
});

describe("CoordinateFrame history against the sorted-array implementation it replaced", () => {
  /**
   * Replays one random scenario on both implementations: a random tree, samples that mostly arrive
   * in time order but sometimes late, repeated or after the history was cut, capacity trims, and
   * reparenting. After each step, transforms through random chains at random times agree bit for
   * bit, including times before, between, on and beyond the stored samples.
   */
  function replay(seed: number, capacity: number, maxStorageTime: Duration): number {
    const rand = random(seed);
    const tree = new TransformTree(maxStorageTime, capacity);
    const frames: CoordinateFrame[] = [];
    const references: ReferenceFrame[] = [];
    const frameCount = 6;
    for (let i = 0; i < frameCount; i++) {
      frames.push(tree.getOrCreateFrame(`f${i}`));
      references.push(new ReferenceFrame(`f${i}`, maxStorageTime, capacity));
    }
    const parentOf = (i: number) => (i === 0 ? -1 : Math.floor(rand() * i));
    for (let i = 1; i < frameCount; i++) {
      const p = parentOf(i);
      frames[i]!.setParent(frames[p]!);
      references[i]!.setParent(references[p]!);
    }

    let now = 1_000n * SECOND;
    let compared = 0;
    const out = mat4.create();
    const expected = mat4.create();
    for (let step = 0; step < 220; step++) {
      now += BigInt(Math.floor(rand() * 40)) * 1_000_000n;
      const i = 1 + Math.floor(rand() * (frameCount - 1));
      const r = rand();
      // Mostly in order; sometimes a late sample, an exact repeat, or a far-past one.
      const time =
        r < 0.7
          ? now
          : r < 0.8
            ? now - BigInt(Math.floor(rand() * 300)) * 1_000_000n
            : r < 0.9
              ? frames[i]!.newestTransformTime() ?? now
              : now - BigInt(Math.floor(rand() * 5)) * SECOND;
      const sample = randomSample(rand, time);
      frames[i]!.addTransformValues(time, sample.position, sample.rotation);
      references[i]!.addTransform(
        time,
        new Transform().setPositionRotation([...sample.position] as vec3, [...sample.rotation] as quat),
      );

      const op = rand();
      if (op < 0.04) {
        const cut = now - BigInt(Math.floor(rand() * 400)) * 1_000_000n;
        frames[i]!.removeTransformsAfter(cut);
        references[i]!.removeAfter(cut);
      } else if (op < 0.08) {
        const at = frames[i]!.newestTransformTime() ?? now;
        frames[i]!.removeTransformAt(at);
        references[i]!.removeAt(at);
      } else if (op < 0.1) {
        const j = 1 + Math.floor(rand() * (frameCount - 1));
        const p = Math.floor(rand() * j);
        frames[j]!.setParent(frames[p]!);
        references[j]!.setParent(references[p]!);
      } else if (op < 0.14) {
        frames[i]!.offsetPosition = [rand(), rand(), rand()];
        references[i]!.offsetPosition = frames[i]!.offsetPosition;
        frames[i]!.offsetEulerDegrees = [rand() * 30, rand() * 30, rand() * 30];
        references[i]!.offsetEulerDegrees = frames[i]!.offsetEulerDegrees;
      }

      expect(frames.map((f) => f.transformsSize())).toEqual(references.map((f) => f.transforms.size));
      expect(frames.map((f) => f.newestTransformTime())).toEqual(
        references.map((f) => f.transforms.maxKey()),
      );
      expect(frames.map((f) => f.getVersion())).toEqual(references.map((f) => f.version));

      for (let probe = 0; probe < 12; probe++) {
        const child = 1 + Math.floor(rand() * (frameCount - 1));
        // Walk to the root of the reference tree so the chain is a real ancestor path.
        let top = references[child]!;
        let topFrame = frames[child]!;
        const hops = Math.floor(rand() * 4);
        for (let h = 0; h < hops && top.parent; h++) {
          top = top.parent;
          topFrame = topFrame.parent()!;
        }
        const which = rand();
        const stamp = frames[child]!.newestTransformTime() ?? now;
        const query =
          which < 0.3
            ? now - BigInt(Math.floor(rand() * 3000)) * 1_000_000n
            : which < 0.5
              ? stamp
              : which < 0.6
                ? stamp + BigInt(Math.floor(rand() * 10)) * SECOND
                : which < 0.7
                  ? 0n
                  : now + BigInt(Math.floor(rand() * 200)) * 1_000_000n - 100_000_000n;
        const maxDelta = rand() < 0.5 ? MAX_DURATION : BigInt(Math.floor(rand() * 4)) * SECOND;
        const ok = CoordinateFrame.GetTransformMatrix(out, topFrame, frames[child]!, query, maxDelta);
        const refOk = referenceMatrix(expected, top, references[child]!, query, maxDelta);
        expect(ok).toBe(refOk);
        expect(ok ? Array.from(out) : undefined).toEqual(refOk ? Array.from(expected) : undefined);
        compared++;
      }
    }
    return compared;
  }

  it.each([
    [1, 16, 2n * SECOND],
    [2, 16, 2n * SECOND],
    [3, 256, 2n * SECOND],
    [4, 8, 600n * SECOND],
    [5, 5, 1n * SECOND],
    [6, 3, 2n * SECOND], // capacities below 4 trim nothing by count; time alone bounds them
    [7, 64, 100_000n * SECOND],
    [8, 32, 500_000_000n],
  ])("gives identical lookups: seed %i, capacity %i, storage %s ns", (seed, capacity, storage) => {
    expect(replay(seed, capacity, storage)).toBeGreaterThan(2000);
  });

  it("fills findClosestTransforms with the stored transforms, matrices included", () => {
    const tree = new TransformTree(2n * SECOND, 64);
    const child = tree.getOrCreateFrame("child");
    child.setParent(tree.getOrCreateFrame("parent"));
    const reference = new ReferenceFrame("child", 2n * SECOND, 64);
    const rand = random(99);
    for (let i = 0; i < 50; i++) {
      const sample = randomSample(rand, BigInt(i) * 100_000_000n);
      child.addTransformValues(sample.time, sample.position, sample.rotation);
      reference.addTransform(
        sample.time,
        new Transform().setPositionRotation([...sample.position] as vec3, [...sample.rotation] as quat),
      );
    }
    const lower: [Time, Transform] = [0n, Transform.Identity()];
    const upper: [Time, Transform] = [0n, Transform.Identity()];
    const refLower: [Time, Transform] = [0n, Transform.Identity()];
    const refUpper: [Time, Transform] = [0n, Transform.Identity()];
    for (const query of [0n, 50_000_000n, 250_000_000n, 1_000_000_000n, 4_900_000_000n, 9_000_000_000n]) {
      const ok = child.findClosestTransforms(lower, upper, query, MAX_DURATION);
      const refOk = reference.findClosest(refLower, refUpper, query, MAX_DURATION);
      expect(ok).toBe(refOk);
      expect(lower[0]).toBe(refLower[0]);
      expect(upper[0]).toBe(refUpper[0]);
      expect(Array.from(lower[1].matrix())).toEqual(Array.from(refLower[1].matrix()));
      expect(Array.from(upper[1].matrix())).toEqual(Array.from(refUpper[1].matrix()));
      expect(Array.from(lower[1].position())).toEqual(Array.from(refLower[1].position()));
      expect(Array.from(upper[1].rotation())).toEqual(Array.from(refUpper[1].rotation()));
    }
  });
});

describe("transform history allocation budget", () => {
  // A memory read that does not depend on the timing of garbage collection: force a full
  // collection first, then read what is still live. Typed array contents live outside the heap,
  // so they are added in.
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const liveBytes = () => {
    gc();
    gc();
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.arrayBuffers;
  };

  const FRAMES = 100;
  const CAPACITY = 256;
  const SAMPLES_PER_FRAME = 600; // far past capacity: the history is full and evicting
  const keys: Time[] = Array.from({ length: SAMPLES_PER_FRAME }, (_, i) => BigInt(i) * 10_000_000n);
  const position: vec3 = [1, 2, 3];
  const rotation: quat = [0, 0, 0.6, 0.8];

  /** What the history of a fleet holds once the live window is full, per live sample. */
  function liveBytesPerSample(fill: (frame: number, key: Time) => void, live: () => number): number {
    const before = liveBytes();
    for (let sample = 0; sample < SAMPLES_PER_FRAME; sample++) {
      for (let frame = 0; frame < FRAMES; frame++) {
        fill(frame, keys[sample]!);
      }
    }
    const after = liveBytes();
    return (after - before) / live();
  }

  it("holds a full fleet history in a small, fixed number of bytes per live sample", () => {
    const tree = new TransformTree(100n * SECOND, CAPACITY);
    const frames: CoordinateFrame[] = [];
    for (let i = 0; i < FRAMES; i++) {
      const frame = tree.getOrCreateFrame(`robot_${i}`);
      frame.setParent(tree.getOrCreateFrame("world"));
      frames.push(frame);
    }
    const bytes = liveBytesPerSample(
      (frame, key) => { frames[frame]!.addTransformValues(key, position, rotation); },
      () => frames.reduce((n, f) => n + f.transformsSize(), 0),
    );
    // 7 doubles of values and one pointer-sized slot per key, on a ring sized for the live window;
    // the key objects are shared with the test's own array here, so they are not counted.
    expect(bytes).toBeLessThan(160);
  });

  it("measures far more for the tuple-and-Transform-per-sample layout it replaced", () => {
    // Control: the same measurement on the old layout, so the bound above means something.
    const references = Array.from(
      { length: FRAMES },
      (_, i) => new ReferenceFrame(`robot_${i}`, 100n * SECOND, CAPACITY),
    );
    const bytes = liveBytesPerSample(
      (frame, key) =>
        { references[frame]!.addTransform(key, new Transform().setPositionRotation([...position] as vec3, [...rotation] as quat)); },
      () => references.reduce((n, f) => n + f.transforms.size, 0),
    );
    expect(bytes).toBeGreaterThan(300);
  });
});
