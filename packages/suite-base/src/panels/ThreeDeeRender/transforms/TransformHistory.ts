// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { quat, vec3 } from "gl-matrix";

import { Duration, Time } from "./time";

/** Values stored per sample: position (3) then unit rotation quaternion (4). */
const STRIDE = 7;
const INITIAL_CAPACITY = 4;

/** A packed (hole-free) array of zero keys: V8 reads these faster than `new Array(n)`'s. */
function packedTimes(length: number): Time[] {
  const times: Time[] = [];
  for (let i = 0; i < length; i++) {
    times.push(0n);
  }
  return times;
}

/**
 * The time-ordered history of one coordinate frame's transform to its parent.
 *
 * A circular buffer of Float64 samples: `times` holds the keys in the order they sort, `values`
 * holds seven doubles per sample. Appending the newest sample, evicting the oldest ones and looking
 * a time up allocate nothing, where a sorted array of `[time, Transform]` tuples allocated a tuple,
 * a transform with three arrays, and re-spliced the array for every sample of every frame. Storage
 * grows geometrically with the number of live samples, so a frame that only ever holds one static
 * transform stays small.
 *
 * Samples are unique by time: setting an existing time replaces its values, and inserting a time
 * older than the newest sample keeps the order, exactly like the sorted-array map it replaces.
 * Rotations are stored as given; callers normalize them once on the way in.
 */
export class TransformHistory {
  /** Keys in a plain array: the BigInt behind each is the only allocation a new sample makes. */
  #times: Time[] = packedTimes(INITIAL_CAPACITY);
  #values = new Float64Array(INITIAL_CAPACITY * STRIDE);
  #capacity = INITIAL_CAPACITY;
  #head = 0;
  #size = 0;

  /** Bracketing sample indices left by the last successful `locate()` call. */
  public lowerIndex = 0;
  public upperIndex = 0;

  // eslint-disable-next-line no-restricted-syntax
  public get size(): number {
    return this.#size;
  }

  public timeAt(index: number): Time {
    return this.#times[this.#slot(index)]!;
  }

  public minKey(): Time | undefined {
    return this.#size === 0 ? undefined : this.timeAt(0);
  }

  public maxKey(): Time | undefined {
    return this.#size === 0 ? undefined : this.timeAt(this.#size - 1);
  }

  /** Copy sample `index` into `position` and `rotation`. */
  public read(index: number, position: vec3, rotation: quat): void {
    const base = this.#slot(index) * STRIDE;
    const values = this.#values;
    position[0] = values[base]!;
    position[1] = values[base + 1]!;
    position[2] = values[base + 2]!;
    rotation[0] = values[base + 3]!;
    rotation[1] = values[base + 4]!;
    rotation[2] = values[base + 5]!;
    rotation[3] = values[base + 6]!;
  }

  /**
   * Index of the sample at `key` if there is one, otherwise the bitwise complement of the index of
   * the first sample with a larger key (the size, complemented, when `key` is the newest so far).
   */
  public binarySearch(key: Time): number {
    const size = this.#size;
    if (size === 0) {
      return -1;
    }
    let left = 0;
    let right = size - 1;
    if (key < this.timeAt(0)) {
      return ~0;
    } else if (key > this.timeAt(right)) {
      return ~size;
    }
    while (left <= right) {
      const mid = (left + right) >> 1;
      const midKey = this.timeAt(mid);
      if (midKey === key) {
        return mid;
      } else if (key < midKey) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    return ~left;
  }

  /** Store a sample, replacing the one at the same time if there is one. */
  public set(
    key: Time,
    position: Readonly<ArrayLike<number>>,
    rotation: Readonly<ArrayLike<number>>,
  ): void {
    let index = this.binarySearch(key);
    if (index < 0) {
      index = ~index;
      this.#insertGap(index);
      this.#times[this.#slot(index)] = key;
    }
    const base = this.#slot(index) * STRIDE;
    const values = this.#values;
    values[base] = position[0]!;
    values[base + 1] = position[1]!;
    values[base + 2] = position[2]!;
    values[base + 3] = rotation[0]!;
    values[base + 4] = rotation[1]!;
    values[base + 5] = rotation[2]!;
    values[base + 6] = rotation[3]!;
  }

  /** Remove every sample older than `key`; returns how many went. */
  public removeBefore(key: Time): number {
    const index = this.binarySearch(key);
    const count = index >= 0 ? index : ~index;
    this.#dropOldest(count);
    return count;
  }

  /** Remove every sample newer than `key`; returns how many went. */
  public removeAfter(key: Time): number {
    const index = this.binarySearch(key);
    const keep = index >= 0 ? index + 1 : ~index;
    const count = this.#size - keep;
    for (let i = keep; i < this.#size; i++) {
      this.#times[this.#slot(i)] = 0n;
    }
    this.#size = keep;
    return count;
  }

  /** Remove the sample at `key`; returns whether there was one. */
  public remove(key: Time): boolean {
    const index = this.binarySearch(key);
    if (index < 0) {
      return false;
    }
    for (let i = index; i < this.#size - 1; i++) {
      this.#copySample(this.#slot(i + 1), this.#slot(i));
    }
    this.#times[this.#slot(this.#size - 1)] = 0n;
    this.#size--;
    return true;
  }

  /** Remove everything; returns how many samples went. */
  public clear(): number {
    const count = this.#size;
    this.#dropOldest(count);
    this.#head = 0;
    return count;
  }

  /**
   * Find the samples that bracket `time`, leaving their indices in `lowerIndex` / `upperIndex`
   * (equal when `time` hits a sample or clamps to the oldest or newest one). A time outside the
   * history by more than `maxDelta` finds nothing.
   */
  public locate(time: Time, maxDelta: Duration): boolean {
    const size = this.#size;
    if (size === 0) {
      return false;
    }
    if (size === 1) {
      // A single sample answers any time up to `maxDelta` after it.
      if (time <= this.timeAt(0) + maxDelta) {
        this.lowerIndex = this.upperIndex = 0;
        return true;
      }
      return false;
    }

    const index = this.binarySearch(time);
    if (index >= 0) {
      this.lowerIndex = this.upperIndex = index;
      return true;
    }

    const greaterThanIndex = ~index;
    if (greaterThanIndex >= size) {
      if (time <= this.timeAt(size - 1) + maxDelta) {
        this.lowerIndex = this.upperIndex = size - 1;
        return true;
      }
      return false;
    }

    const lessThanIndex = greaterThanIndex - 1;
    if (lessThanIndex < 0) {
      if (this.timeAt(0) + maxDelta >= time) {
        this.lowerIndex = this.upperIndex = 0;
        return true;
      }
      return false;
    }

    this.lowerIndex = lessThanIndex;
    this.upperIndex = greaterThanIndex;
    return true;
  }

  #slot(index: number): number {
    const slot = this.#head + index;
    return slot >= this.#capacity ? slot - this.#capacity : slot;
  }

  #dropOldest(count: number): void {
    for (let i = 0; i < count; i++) {
      this.#times[this.#slot(i)] = 0n;
    }
    this.#head += count;
    if (this.#head >= this.#capacity) {
      this.#head -= this.#capacity;
    }
    this.#size -= count;
  }

  #copySample(from: number, to: number): void {
    this.#times[to] = this.#times[from]!;
    this.#values.copyWithin(to * STRIDE, from * STRIDE, (from + 1) * STRIDE);
  }

  /** Open a free slot at logical `index`, shifting later samples one place towards the newest. */
  #insertGap(index: number): void {
    if (this.#size === this.#capacity) {
      this.#grow();
    }
    for (let i = this.#size; i > index; i--) {
      this.#copySample(this.#slot(i - 1), this.#slot(i));
    }
    this.#size++;
  }

  /** Double the storage, laying the samples out from slot 0. */
  #grow(): void {
    const capacity = this.#capacity * 2;
    const times = packedTimes(capacity);
    const values = new Float64Array(capacity * STRIDE);
    for (let i = 0; i < this.#size; i++) {
      const slot = this.#slot(i);
      times[i] = this.#times[slot]!;
      values.set(this.#values.subarray(slot * STRIDE, (slot + 1) * STRIDE), i * STRIDE);
    }
    this.#times = times;
    this.#values = values;
    this.#capacity = capacity;
    this.#head = 0;
  }
}
