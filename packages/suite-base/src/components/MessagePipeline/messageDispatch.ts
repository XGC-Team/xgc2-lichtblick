// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

/** A subscription-time plan. It owns no messages and can be reused across frames. */
export type MessageDispatchPlan = {
  groups: readonly (readonly string[])[];
  groupsByTopic: ReadonlyMap<string, readonly number[]>;
};

/** Group equivalent topic interests so immutable delivery arrays need only be built once. */
export function compileMessageDispatch(
  subscriptions: ReadonlyMap<string, readonly { readonly topic: string }[]>,
): MessageDispatchPlan {
  const groups: string[][] = [];
  const groupsByTopic = new Map<string, number[]>();
  const groupByInterests = new Map<string, number>();
  for (const [id, payloads] of subscriptions) {
    const topics = [...new Set(payloads.map((payload) => payload.topic))].sort();
    if (topics.length === 0) {
      continue;
    }
    // Encoding is only done when subscriptions change, never on the message hot path.
    // A defined array of strings always serializes to a string.
    const key = JSON.stringify(topics)!;
    const existingGroup = groupByInterests.get(key);
    if (existingGroup != undefined) {
      groups[existingGroup]!.push(id);
      continue;
    }
    const groupIndex = groups.length;
    groupByInterests.set(key, groupIndex);
    groups.push([id]);
    for (const topic of topics) {
      const topicGroups = groupsByTopic.get(topic);
      if (topicGroups == undefined) {
        groupsByTopic.set(topic, [groupIndex]);
      } else {
        topicGroups.push(groupIndex);
      }
    }
  }
  return { groups, groupsByTopic };
}

/**
 * Preserve input ordering and object identity without serializing, sampling or copying payloads.
 * A fresh array is created per active interest group per frame; consumers must treat it as readonly.
 * Neither this plan nor the next frame mutates or retains the returned delivery arrays.
 */
export function dispatchMessages<T extends { readonly topic: string }>(
  messages: readonly T[],
  plan: MessageDispatchPlan,
  lastMessageByTopic: Map<string, T>,
): Map<string, readonly T[]> {
  const buckets: (T[] | undefined)[] = new Array(plan.groups.length);
  for (const message of messages) {
    lastMessageByTopic.set(message.topic, message);
    const groups = plan.groupsByTopic.get(message.topic);
    if (groups == undefined) {
      continue;
    }
    for (const group of groups) {
      const bucket = buckets[group];
      if (bucket == undefined) {
        buckets[group] = [message];
      } else {
        bucket.push(message);
      }
    }
  }
  const result = new Map<string, readonly T[]>();
  for (let group = 0; group < buckets.length; group++) {
    const bucket = buckets[group];
    if (bucket != undefined) {
      for (const id of plan.groups[group]!) {
        result.set(id, bucket);
      }
    }
  }
  return result;
}
