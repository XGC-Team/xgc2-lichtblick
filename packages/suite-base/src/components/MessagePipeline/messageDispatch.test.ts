// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { compileMessageDispatch, dispatchMessages } from "./messageDispatch";

describe("compiled message dispatch", () => {
  it("shares immutable arrays only for identical interests, preserving order and identity", () => {
    const plan = compileMessageDispatch(
      new Map([
        ["first", [{ topic: "/a" }, { topic: "/b" }, { topic: "/a" }]],
        ["same", [{ topic: "/b" }, { topic: "/a" }]],
        ["other", [{ topic: "/b" }]],
        ["inactive", [{ topic: "/inactive" }]],
      ]),
    );
    const messages = Object.freeze([
      Object.freeze({ topic: "/a", value: 1 }),
      Object.freeze({ topic: "/b", value: 2 }),
      Object.freeze({ topic: "/a", value: 3 }),
      Object.freeze({ topic: "/unsubscribed", value: 4 }),
    ]);
    const latest = new Map<string, (typeof messages)[number]>();
    const result = dispatchMessages(messages, plan, latest);
    expect(result.get("first")).toEqual(messages.slice(0, 3));
    expect(result.get("same")).toBe(result.get("first"));
    expect(result.get("other")).toEqual([messages[1]]);
    expect(result.get("other")?.[0]).toBe(messages[1]);
    expect(result.has("inactive")).toBe(false);
    expect(latest.get("/unsubscribed")).toBe(messages[3]);
    Object.freeze(result.get("first"));
    const next = dispatchMessages(messages, plan, latest);
    expect(next.get("first")).not.toBe(result.get("first"));
    expect(next.get("first")).toEqual(result.get("first"));
    expect(dispatchMessages([], plan, latest).size).toBe(0);
  });

  it("matches ordered filtering across 100 seeded subscription and frame workloads", () => {
    let seed = 78;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const topics = ["/a", "/b", "/c", "__proto__", "a,b", "a", "b"];
    for (let trial = 0; trial < 100; trial++) {
      const subscriptions = new Map<string, { topic: string }[]>();
      for (let panel = 0; panel < 20; panel++) {
        subscriptions.set(
          String(panel),
          topics.filter(() => random() > 0.5).map((topic) => ({ topic })),
        );
      }
      const messages = Array.from({ length: 200 }, (_, value) => ({
        topic: topics[Math.floor(random() * topics.length)]!,
        value,
      }));
      const latest = new Map<string, (typeof messages)[number]>();
      const actual = dispatchMessages(messages, compileMessageDispatch(subscriptions), latest);
      for (const [id, payloads] of subscriptions) {
        const interested = new Set(payloads.map(({ topic }) => topic));
        const expected = messages.filter(({ topic }) => interested.has(topic));
        expect(actual.get(id) ?? []).toEqual(expected);
        for (let i = 0; i < expected.length; i++) {
          expect(actual.get(id)?.[i]).toBe(expected[i]);
        }
      }
      expect(latest).toEqual(new Map(messages.map((message) => [message.topic, message])));
    }
  });

  it("does not collide topic names containing separators or prototype keys", () => {
    const plan = compileMessageDispatch(
      new Map([
        ["one", [{ topic: "a,b" }]],
        ["two", [{ topic: "a" }, { topic: "b" }]],
        ["prototype", [{ topic: "__proto__" }]],
      ]),
    );
    const message = { topic: "a,b" };
    expect(dispatchMessages([message], plan, new Map())).toEqual(new Map([["one", [message]]]));
    expect(plan.groups).toHaveLength(3);
  });
});
