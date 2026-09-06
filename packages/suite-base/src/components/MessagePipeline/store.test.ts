// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { createMessagePipelineStore } from "./store";

describe("message pipeline subscription invalidation", () => {
  it("does not notify on a redundant update or unsubscribe", () => {
    const store = createMessagePipelineStore({
      initialPlayer: undefined,
      promisesToWaitForRef: { current: [] },
    });
    const notify = jest.fn();
    store.subscribe(notify);
    store.getState().public.setSubscriptions("panel", [{ topic: "/a", fields: ["value"] }]);
    const state = store.getState();
    notify.mockClear();
    state.public.setSubscriptions("panel", [{ topic: "/a", fields: ["value"] }]);
    state.public.setSubscriptions("absent", []);
    expect(store.getState()).toBe(state);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reuses player subscriptions when an equivalent panel is added or removed", () => {
    const store = createMessagePipelineStore({
      initialPlayer: undefined,
      promisesToWaitForRef: { current: [] },
    });
    const setSubscriptions = store.getState().public.setSubscriptions;
    setSubscriptions("first", [{ topic: "/a" }]);
    const subscriptions = store.getState().public.subscriptions;
    setSubscriptions("second", [{ topic: "/a" }]);
    expect(store.getState().public.subscriptions).toBe(subscriptions);
    expect(store.getState().messageDispatchPlan.groups).toEqual([["first", "second"]]);
    setSubscriptions("first", []);
    expect(store.getState().public.subscriptions).toBe(subscriptions);
    store.getState().reset();
    expect(store.getState().messageDispatchPlan.groups).toEqual([]);
    expect(store.getState().lastMessageEventByTopic.size).toBe(0);
  });
});
