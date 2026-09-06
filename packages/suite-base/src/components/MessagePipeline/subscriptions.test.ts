// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { mergeSubscriptions } from "@lichtblick/suite-base/components/MessagePipeline/subscriptions";
import { InternalSubscribePayload } from "@lichtblick/suite-base/players/types";

describe("mergeSubscriptions", () => {
  it("combines full and partial subscriptions", () => {
    const subs: InternalSubscribePayload[] = [
      { topic: "a", preloadType: "full" },
      { topic: "a", preloadType: "partial" },
    ];

    const result = mergeSubscriptions(subs);

    expect(result).toEqual([
      { topic: "a", preloadType: "full" },
      { topic: "a", preloadType: "partial" },
    ]);
  });

  it("combines full and partial and sliced subscriptions", () => {
    const subs: InternalSubscribePayload[] = [
      { topic: "a", preloadType: "full" },
      { topic: "a", preloadType: "partial" },
      { topic: "a", preloadType: "partial", fields: ["one", "two"] },
    ];

    const result = mergeSubscriptions(subs);

    expect(result).toEqual([
      { topic: "a", preloadType: "full" },
      { topic: "a", preloadType: "partial" },
    ]);
  });

  it("excludes empty slices", () => {
    const subs: InternalSubscribePayload[] = [
      { topic: "b", preloadType: "full", fields: ["one", "two"] },
      { topic: "b", preloadType: "partial", fields: ["one", "two", "three"] },
      { topic: "c", preloadType: "partial", fields: [] },
    ];

    const result = mergeSubscriptions(subs);

    expect(result).toEqual([
      { topic: "b", preloadType: "full", fields: ["one", "two"] },
      { topic: "b", preloadType: "partial", fields: ["one", "two", "three"] },
    ]);
  });

  it("switches to subscribing to all fields", () => {
    const subs: InternalSubscribePayload[] = [
      { topic: "a", preloadType: "partial", fields: ["one", "two"] },
      { topic: "a", preloadType: "full", fields: ["one", "two"] },
      { topic: "a", preloadType: "partial" },
    ];

    const result = mergeSubscriptions(subs);

    expect(result).toEqual([
      { topic: "a", preloadType: "full", fields: ["one", "two"] },
      { topic: "a", preloadType: "partial" },
    ]);
  });

  it("switches to subscribing to all fields across preloadType", () => {
    const subs: InternalSubscribePayload[] = [
      { topic: "a", preloadType: "partial", fields: ["one", "two"] },
      { topic: "a", preloadType: "full" },
    ];

    const result = mergeSubscriptions(subs);

    expect(result).toEqual([
      { topic: "a", preloadType: "full" },
      { topic: "a", preloadType: "partial" },
    ]);
  });

  it("keeps sampling when all subscribers are compatible and at least one is sampling-authorized", () => {
    // Given
    const subs: InternalSubscribePayload[] = [
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
      },
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
        samplingAuthorized: true,
      },
    ];

    // When
    const result = mergeSubscriptions(subs);

    // Then
    expect(result).toEqual([
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
        samplingAuthorized: true,
      },
    ]);
  });

  it("keeps sampling regardless of subscription order when approval is present", () => {
    // Given
    const subs: InternalSubscribePayload[] = [
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
        samplingAuthorized: true,
      },
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
      },
    ];

    // When
    const result = mergeSubscriptions(subs);

    // Then
    expect(result).toEqual([
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
        samplingAuthorized: true,
      },
    ]);
  });

  it("drops sampling when no merged subscriber is sampling-authorized", () => {
    // Given
    const subs: InternalSubscribePayload[] = [
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
      },
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
      },
    ];

    // When
    const result = mergeSubscriptions(subs);

    // Then
    expect(result).toEqual([{ topic: "a", preloadType: "partial" }]);
  });

  it("drops sampling for a single unapproved sampling subscription", () => {
    // Given
    const subs: InternalSubscribePayload[] = [
      {
        topic: "a",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
      },
    ];

    // When
    const result = mergeSubscriptions(subs);

    // Then
    expect(result).toEqual([{ topic: "a", preloadType: "partial" }]);
  });
});

describe("subscription accumulator compatibility", () => {
  it("preserves the empty-union whole-message behavior and does not mutate inputs", () => {
    const subscriptions = [
      { topic: "/a", fields: [" "] },
      { topic: "/a", fields: [""] },
      { topic: "/a", fields: ["value"] },
    ];
    const snapshot = JSON.stringify(subscriptions);
    expect(mergeSubscriptions(subscriptions)[0]?.fields).toBeUndefined();
    expect(JSON.stringify(subscriptions)).toBe(snapshot);
  });

  it("trims a merged union once and preserves singleton fields", () => {
    expect(
      mergeSubscriptions([
        { topic: "/a", fields: [" x ", "y"] },
        { topic: "/a", fields: ["x", " z ", ""] },
        { topic: "/single", fields: [" x "] },
      ]),
    ).toEqual([
      { topic: "/a", fields: ["x", "y", "z"] },
      { topic: "/single", fields: [" x "] },
    ]);
  });

  it("keeps prototype-like topic names separate", () => {
    expect(mergeSubscriptions([{ topic: "__proto__" }, { topic: "constructor" }])).toEqual([
      { topic: "__proto__" },
      { topic: "constructor" },
    ]);
  });
});
