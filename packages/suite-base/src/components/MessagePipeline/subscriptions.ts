// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Immutable } from "@lichtblick/suite";
import { applySamplingGuardToSubscription } from "@lichtblick/suite-base/players/samplingGuard";
import { InternalSubscribePayload } from "@lichtblick/suite-base/players/types";

type Subscription = Immutable<InternalSubscribePayload>;
type Accumulator = {
  first: Subscription;
  count: number;
  allEmpty: boolean;
  whole: boolean;
  fields: Set<string>;
  samplingRequest: Subscription["samplingRequest"];
  samplingAuthorized: Subscription["samplingAuthorized"];
};

function addFields(fields: Set<string>, values: readonly string[] | undefined): void {
  for (const value of values ?? []) {
    const field = value.trim();
    if (field.length > 0) {
      fields.add(field);
    }
  }
}

function accumulate(groups: Record<string, Accumulator>, subscription: Subscription): void {
  let group = groups[subscription.topic];
  if (group == undefined) {
    group = {
      first: subscription,
      count: 1,
      allEmpty: subscription.fields?.length === 0,
      whole: subscription.fields == undefined,
      fields: new Set(),
      samplingRequest: subscription.samplingRequest,
      samplingAuthorized: subscription.samplingAuthorized,
    };
    addFields(group.fields, subscription.fields);
    groups[subscription.topic] = group;
    return;
  }
  group.count++;
  group.allEmpty = group.allEmpty && subscription.fields?.length === 0;
  if (!group.whole) {
    addFields(group.fields, subscription.fields);
    // Preserve the established left-fold behavior: an empty normalized union means all fields.
    group.whole = subscription.fields == undefined || group.fields.size === 0;
  }
  const sameSamplingMode =
    group.samplingRequest?.mode != undefined &&
    group.samplingRequest.mode === subscription.samplingRequest?.mode;
  group.samplingRequest = sameSamplingMode ? group.samplingRequest : undefined;
  group.samplingAuthorized =
    sameSamplingMode &&
    (group.samplingAuthorized === true || subscription.samplingAuthorized === true)
      ? true
      : undefined;
}

function finish(groups: Record<string, Accumulator>, output: Subscription[]): void {
  for (const group of Object.values(groups)) {
    if (group.allEmpty) {
      continue;
    }
    const merged =
      group.count === 1
        ? group.first
        : {
            ...group.first,
            fields: group.whole ? undefined : [...group.fields],
            samplingRequest: group.samplingRequest,
            samplingAuthorized: group.samplingAuthorized,
          };
    output.push(applySamplingGuardToSubscription(merged));
  }
}

/**
 * One pass over subscriptions and their fields, rather than repeatedly copying growing unions.
 * Full subscriptions imply partial subscriptions. Whole-message requests win over field slices;
 * sampling survives only when every request agrees and the shared authorization guard approves it.
 */
export function mergeSubscriptions(
  subscriptions: Immutable<InternalSubscribePayload[]>,
): Immutable<InternalSubscribePayload[]> {
  const full: Record<string, Accumulator> = Object.create(null);
  const partial: Record<string, Accumulator> = Object.create(null);
  for (const subscription of subscriptions) {
    if (subscription.preloadType === "full") {
      accumulate(full, subscription);
      accumulate(partial, { ...subscription, preloadType: "partial" });
    } else {
      accumulate(partial, subscription);
    }
  }
  const output: Subscription[] = [];
  finish(full, output);
  finish(partial, output);
  return output;
}

/** Compare effective requests, treating absent optional properties like explicit undefined. */
export function subscriptionsEqual(
  left: readonly Subscription[],
  right: readonly Subscription[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((subscription, index) => {
        const other = right[index]!;
        return (
          subscription.topic === other.topic &&
          subscription.preloadType === other.preloadType &&
          subscription.samplingRequest?.mode === other.samplingRequest?.mode &&
          subscription.samplingAuthorized === other.samplingAuthorized &&
          (subscription.fields === other.fields ||
            (subscription.fields != undefined &&
              subscription.fields.length === other.fields?.length &&
              subscription.fields.every((field, i) => field === other.fields?.[i])))
        );
      }))
  );
}
