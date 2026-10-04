// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { toNanoSec } from "@lichtblick/rostime";
import { normalizeTFMessage } from "@lichtblick/suite-base/panels/ThreeDeeRender/normalizeMessages";

import { Time } from "./time";

/** Floats per transform in `TfBatch.values`: translation x y z, then rotation x y z w. */
export const TF_BATCH_STRIDE = 7;

/**
 * One tf2_msgs/TFMessage decoded for ingestion: frame ids, nanosecond stamps and a flat table of
 * numbers, with no per-transform objects. The rotation is as received; whoever stores it
 * normalizes it.
 */
export type TfBatch = {
  count: number;
  parentIds: string[];
  childIds: string[];
  stamps: Time[];
  values: Float64Array;
  /** Set only for the transforms whose stamp could not be decoded, indexed like the others. */
  errors: (Error | undefined)[] | undefined;
};

// A message is decoded once however many panels receive it: the same message object reaches every
// 3D and image panel that subscribes to its topic, and each of them ingests the same transforms
// into its own tree. Frame ids are only normalized one of two ways, so there are two tables.
const decodedWithRosIds = new WeakMap<object, TfBatch>();
const decodedWithPlainIds = new WeakMap<object, TfBatch>();

export function tfBatchFor(
  message: object,
  // eslint-disable-next-line @lichtblick/no-boolean-parameters
  stripLeadingSlash: boolean,
): TfBatch {
  const cache = stripLeadingSlash ? decodedWithRosIds : decodedWithPlainIds;
  let batch = cache.get(message);
  if (!batch) {
    batch = decodeTfBatch(message, stripLeadingSlash);
    cache.set(message, batch);
  }
  return batch;
}

/** Match the behavior of `tf::Transformer` by stripping a leading slash from ROS frame ids. */
// eslint-disable-next-line @lichtblick/no-boolean-parameters
function frameId(id: string, stripLeadingSlash: boolean): string {
  return stripLeadingSlash && id.startsWith("/") ? id.slice(1) : id;
}

export function decodeTfBatch(
  message: object,
  // eslint-disable-next-line @lichtblick/no-boolean-parameters
  stripLeadingSlash: boolean,
): TfBatch {
  const { transforms } = normalizeTFMessage(message);
  const count = transforms.length;
  const batch: TfBatch = {
    count,
    parentIds: new Array<string>(count),
    childIds: new Array<string>(count),
    stamps: new Array<Time>(count),
    values: new Float64Array(count * TF_BATCH_STRIDE),
    errors: undefined,
  };
  const { values } = batch;
  for (let i = 0; i < count; i++) {
    const tf = transforms[i]!;
    batch.parentIds[i] = frameId(tf.header.frame_id, stripLeadingSlash);
    batch.childIds[i] = frameId(tf.child_frame_id, stripLeadingSlash);
    try {
      batch.stamps[i] = toNanoSec(tf.header.stamp);
    } catch (error) {
      batch.stamps[i] = 0n;
      (batch.errors ??= new Array<Error | undefined>(count))[i] = error as Error;
    }
    const { translation, rotation } = tf.transform;
    const base = i * TF_BATCH_STRIDE;
    values[base] = translation.x;
    values[base + 1] = translation.y;
    values[base + 2] = translation.z;
    values[base + 3] = rotation.x;
    values[base + 4] = rotation.y;
    values[base + 5] = rotation.z;
    values[base + 6] = rotation.w;
  }
  return batch;
}
