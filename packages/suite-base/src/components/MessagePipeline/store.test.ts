// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { MessageEvent } from "@lichtblick/suite";
import { PlayerPresence, PlayerState } from "@lichtblick/suite-base/players/types";

import { createMessagePipelineStore, defaultPlayerState } from "./store";

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

describe("late static TF subscribers", () => {
  function event(children: string[], topic = "/tf_static", sizeInBytes = 100): MessageEvent {
    return {
      topic,
      schemaName: "tf2_msgs/TFMessage",
      receiveTime: { sec: 100, nsec: 0 },
      sizeInBytes,
      message: {
        transforms: children.map((child) => ({
          header: { frame_id: "world" },
          child_frame_id: child,
        })),
      },
    };
  }
  function setup() {
    const store = createMessagePipelineStore({
      initialPlayer: undefined,
      promisesToWaitForRef: { current: [] },
    });
    const subscribe = (id: string, topics: string[]) => {
      store.getState().public.setSubscriptions(
        id,
        topics.map((topic) => ({ topic })),
      );
    };
    const emit = (
      messages: MessageEvent[],
      lastSeekTime = 0,
      presence = PlayerPresence.PRESENT,
    ) => {
      store.getState().dispatch({
        type: "update-player-state",
        playerState: {
          ...defaultPlayerState(),
          presence,
          activeData: { messages, lastSeekTime },
        } as unknown as PlayerState,
      });
    };
    const delivered = (id: string) =>
      store.getState().public.messageEventsBySubscriberId.get(id) ?? [];
    const children = (id: string) =>
      delivered(id).flatMap((msg) =>
        (msg.message as { transforms: { child_frame_id: string }[] }).transforms.map(
          (tf) => tf.child_frame_id,
        ),
      );
    return { store, subscribe, emit, delivered, children };
  }

  it("backfills all publisher fragments to a late panel and updates a child without disturbing others", () => {
    const h = setup();
    h.subscribe("early", ["/tf_static"]);
    h.emit([event(["map", "xgc_origin"]), event(["scene/0", "scene/1"])]);
    expect(h.delivered("early")).toHaveLength(2);
    h.subscribe("late", ["/tf_static"]);
    expect(h.children("late")).toEqual(["map", "xgc_origin", "scene/0", "scene/1"]);
    const changed = event(["map"]);
    (changed.message as { transforms: { header: { frame_id: string } }[] })
      .transforms[0]!.header.frame_id = "new-world";
    h.emit([changed]);
    h.subscribe("newer", ["/tf_static"]);
    expect(h.children("newer")).toEqual(["map", "xgc_origin", "scene/0", "scene/1"]);
    expect(
      (h.delivered("newer")[0]!.message as { transforms: { header: { frame_id: string } }[] })
        .transforms[0]!.header.frame_id,
    ).toBe("new-world");
    h.emit([event(["/map"])]);
    h.subscribe("alias", ["/tf_static"]);
    expect(h.children("alias")).toEqual(["/map", "xgc_origin", "scene/0", "scene/1"]);
  });

  it("clears the snapshot on last unsubscribe, reconnect, seek and reset", () => {
    const h = setup();
    h.subscribe("first", ["/tf_static"]);
    h.emit([event(["old"])]);
    h.subscribe("first", []);
    h.subscribe("again", ["/tf_static"]);
    expect(h.delivered("again")).toHaveLength(0);
    h.emit([event(["before-reconnect"])]);
    h.emit([], 0, PlayerPresence.RECONNECTING);
    h.emit([event(["after-reconnect"])]);
    h.subscribe("late", ["/tf_static"]);
    expect(h.children("late")).toEqual(["after-reconnect"]);
    h.emit([event(["after-seek"])], 1);
    h.subscribe("seek", ["/tf_static"]);
    expect(h.children("seek")).toEqual(["after-seek"]);
    h.store.getState().reset();
    h.subscribe("reset", ["/tf_static"]);
    expect(h.delivered("reset")).toHaveLength(0);
  });

  it("keeps ordinary topics latest-only and refuses incomplete oversized or malformed snapshots", () => {
    const h = setup();
    h.subscribe("first", ["/tf_static", "/other"]);
    h.emit([event(["a"], "/other"), event(["b"], "/other"), event(["map"])]);
    h.subscribe("ordinary", ["/other"]);
    expect(h.children("ordinary")).toEqual(["b"]);
    h.emit([event(["huge"], "/tf_static", 16 * 1024 * 1024 + 1)]);
    h.subscribe("overflow", ["/tf_static"]);
    expect(h.delivered("overflow")).toHaveLength(0);
    h.subscribe("first", []);
    h.subscribe("overflow", []);
    h.subscribe("fresh", ["/tf_static"]);
    h.emit([{ ...event(["bad"]), message: { transforms: [{}] } }]);
    h.subscribe("malformed", ["/tf_static"]);
    expect(h.delivered("malformed")).toHaveLength(0);
  });
});
