import { compileMessageDispatch, dispatchMessages } from "./messageDispatch";
import { setNativeCloudProvenance } from "../../players/nativeCloudPreparation";
import type { InternalSubscribePayload } from "../../players/types";
import type { MessageEvent } from "@lichtblick/suite";
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

it("retains one original native cloud for revision replay without dispatching an eligible CPU handler", () => {
  const store = createMessagePipelineStore({
    initialPlayer: undefined,
    promisesToWaitForRef: { current: [] },
  });
  const channel = {};
  const current: MessageEvent = {
    topic: "/cloud",
    schemaName: "foxglove.PointCloud",
    receiveTime: { sec: 1, nsec: 0 },
    sizeInBytes: 0,
    message: { data: new Uint8Array(0) },
  };
  setNativeCloudProvenance(current, {
    channel,
    subscriptionId: 1,
    generation: 2,
    ingressSequence: 4,
  });
  store.getState().public.retainNativeCloud(current);
  const older = { ...current };
  setNativeCloudProvenance(older, {
    channel,
    subscriptionId: 1,
    generation: 2,
    ingressSequence: 3,
  });
  store.getState().public.retainNativeCloud(older);
  const history = dispatchMessages(
    [older],
    compileMessageDispatch(new Map([["history", [{ topic: "/cloud" }]]])),
    store.getState().lastMessageEventByTopic,
  );
  expect(history.get("history")).toEqual([older]); // Ordered delivery is not filtered; only latest replay is monotonic.
  expect(store.getState().public.getLatestNativeCloud("/cloud")).toBe(current);
  store.getState().public.setSubscriptions("native", [
    {
      topic: "/cloud",
      samplingAuthorized: true,
      samplingRequest: { mode: "latest-per-render-tick" },
      nativeCloudConsumers: [
        { identity: {} } as import("../../players/nativeCloudPreparation").NativeCloudConsumer,
      ],
      nativeCloudPreparationAllowed: true,
    } as InternalSubscribePayload,
  ]);
  expect(store.getState().public.messageEventsBySubscriberId.get("native")).toBeUndefined();
  store.getState().public.setSubscriptions("native", []);
  expect(store.getState().public.getLatestNativeCloud("/cloud")).toBeUndefined();
});
