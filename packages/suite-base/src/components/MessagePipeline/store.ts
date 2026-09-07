// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import { MutableRefObject } from "react";
import shallowequal from "shallowequal";
import { createStore, StoreApi } from "zustand";

import { Condvar } from "@lichtblick/den/async";
import { Time } from "@lichtblick/rostime";
import { Immutable, MessageEvent } from "@lichtblick/suite";
import {
  mergeSubscriptions,
  subscriptionsEqual,
} from "@lichtblick/suite-base/components/MessagePipeline/subscriptions";
import { PLAYER_CAPABILITIES } from "@lichtblick/suite-base/players/constants";
import {
  AdvertiseOptions,
  Player,
  PlayerPresence,
  PlayerState,
  SubscribePayload,
} from "@lichtblick/suite-base/players/types";
import isDesktopApp from "@lichtblick/suite-base/util/isDesktopApp";

import { compileMessageDispatch, dispatchMessages, MessageDispatchPlan } from "./messageDispatch";
import { FramePromise } from "./pauseFrameForPromise";
import { MessagePipelineContext } from "./types";

export function defaultPlayerState(player?: Player): PlayerState {
  return {
    // when there is a player we default to initializing, to prevent thrashing in the UI when
    // the player is initialized.
    presence: player ? PlayerPresence.INITIALIZING : PlayerPresence.NOT_PRESENT,
    progress: {},
    capabilities: [],
    profile: undefined,
    playerId: "",
    activeData: undefined,
  };
}

export type MessagePipelineInternalState = {
  dispatch: (action: MessagePipelineStateAction) => void;

  /** Reset public and private state back to initial empty values */
  reset: () => void;

  player?: Player;

  /** used to keep track of whether we need to update public.startPlayback/playUntil/etc. */
  lastCapabilities: string[];
  subscriptionsById: Map<string, Immutable<SubscribePayload[]>>;
  publishersById: { [key: string]: AdvertiseOptions[] };
  allPublishers: AdvertiseOptions[];
  /** Compiled topic interests; equivalent consumers share immutable frame arrays. */
  messageDispatchPlan: MessageDispatchPlan;
  /** This holds the last message emitted by the player on each topic. Attempt to use this before falling back to player backfill.
   */
  lastMessageEventByTopic: Map<string, MessageEvent>;
  /** Function to call when react render has completed with the latest state */
  renderDone?: () => void;

  /** Part of the state that is exposed to consumers via useMessagePipeline */
  public: MessagePipelineContext;
};

type UpdateSubscriberAction = {
  type: "update-subscriber";
  id: string;
  payloads: Immutable<SubscribePayload[]>;
};
type UpdatePlayerStateAction = {
  type: "update-player-state";
  playerState: PlayerState;
  renderDone?: () => void;
};

export type MessagePipelineStateAction =
  | UpdateSubscriberAction
  | UpdatePlayerStateAction
  | { type: "set-publishers"; id: string; payloads: AdvertiseOptions[] };

export function createMessagePipelineStore({
  promisesToWaitForRef,
  initialPlayer,
}: {
  promisesToWaitForRef: MutableRefObject<FramePromise[]>;
  initialPlayer: Player | undefined;
}): StoreApi<MessagePipelineInternalState> {
  return createStore((set, get) => ({
    player: initialPlayer,
    publishersById: {},
    allPublishers: [],

    subscriptionsById: new Map(),
    messageDispatchPlan: compileMessageDispatch(new Map()),

    lastMessageEventByTopic: new Map(),
    lastCapabilities: [],

    dispatch(action) {
      set((state) => reducer(state, action));
    },

    reset() {
      set((prev) => ({
        ...prev,
        publishersById: {},
        allPublishers: [],

        subscriptionsById: new Map(),
        messageDispatchPlan: compileMessageDispatch(new Map()),

        lastMessageEventByTopic: new Map(),
        lastCapabilities: [],
        public: {
          ...prev.public,
          playerState: defaultPlayerState(),
          messageEventsBySubscriberId: new Map(),
          subscriptions: [],
          sortedTopics: [],
          sortedServices: [],
          datatypes: new Map(),
          startPlayback: undefined,
          playUntil: undefined,
          pausePlayback: undefined,
          setPlaybackSpeed: undefined,
          seekPlayback: undefined,
        },
      }));
    },

    public: {
      playerState: defaultPlayerState(initialPlayer),
      messageEventsBySubscriberId: new Map(),
      subscriptions: [],
      sortedTopics: [],
      sortedServices: [],
      datatypes: new Map(),
      setSubscriptions(id, payloads) {
        get().dispatch({ type: "update-subscriber", id, payloads });
      },
      setPublishers(id, payloads) {
        get().dispatch({ type: "set-publishers", id, payloads });
        get().player?.setPublishers(get().allPublishers);
      },
      setParameter(key, value) {
        get().player?.setParameter(key, value);
      },
      publish(payload) {
        get().player?.publish(payload);
      },
      async callService(service, request) {
        const player = get().player;
        if (!player) {
          throw new Error("callService called when player is not present");
        }
        return await player.callService(service, request);
      },
      async fetchAsset(uri, options) {
        const { protocol } = new URL(uri);
        const player = get().player;

        if (protocol === "package:") {
          // For the desktop app, package:// is registered as a supported schema for builtin _fetch_ calls.
          const canBuiltinFetchPkgUri = isDesktopApp();
          const pkgPath = uri.slice("package://".length);
          const pkgName = pkgPath.split("/")[0];

          if (player?.fetchAsset) {
            try {
              return await player.fetchAsset(uri);
            } catch (err: unknown) {
              if (canBuiltinFetchPkgUri) {
                // Fallback to a builtin _fetch_ call if the asset couldn't be loaded through the player.
                return await builtinFetch(uri, options);
              }
              throw err; // Bail out otherwise.
            }
          } else if (canBuiltinFetchPkgUri) {
            return await builtinFetch(uri, options);
          } else if (
            pkgName &&
            options?.referenceUrl != undefined &&
            !options.referenceUrl.startsWith("package://") &&
            options.referenceUrl.includes(pkgName)
          ) {
            // As last resort to load the package://<pkgName>/<pkgPath> URL, we resolve the package URL to
            // be relative of the base URL (which contains <pkgName> and is not a package:// URL itself).
            // Example:
            //   base URL: https://example.com/<pkgName>/urdf/robot.urdf
            //   resolved: https://example.com/<pkgName>/<pkgPath>
            const resolvedUrl =
              options.referenceUrl.slice(0, options.referenceUrl.lastIndexOf(pkgName)) + pkgPath;
            return await builtinFetch(resolvedUrl, options);
          }
        }

        // Use a regular fetch for all other protocols
        return await builtinFetch(uri, options);
      },
      getMetadata() {
        const player = get().player;
        return player?.getMetadata?.() ?? Object.freeze([]);
      },
      getBatchIterator(topic: string, options?: { start?: Time; end?: Time }) {
        const player = get().player;
        return player?.getBatchIterator(topic, options);
      },
      startPlayback: undefined,
      playUntil: undefined,
      pausePlayback: undefined,
      setPlaybackSpeed: undefined,
      seekPlayback: undefined,

      pauseFrame(name: string) {
        const condvar = new Condvar();
        promisesToWaitForRef.current.push({ name, promise: condvar.wait() });
        return () => {
          condvar.notifyAll();
        };
      },
    },
  }));
}
/** Update subscriptions. New topics that have already emit messages previously we emit the last message on the topic to the subscriber */
function updateSubscriberAction(
  prevState: MessagePipelineInternalState,
  action: UpdateSubscriberAction,
): MessagePipelineInternalState {
  const previousSubscriptionsById = prevState.subscriptionsById;
  const previousPayloads = previousSubscriptionsById.get(action.id);
  if (
    (previousPayloads == undefined && action.payloads.length === 0) ||
    _.isEqual(previousPayloads, action.payloads)
  ) {
    return prevState;
  }

  const subscriptionsById = new Map(previousSubscriptionsById);

  if (action.payloads.length === 0) {
    // When a subscription id has no topics we removed it from our map
    subscriptionsById.delete(action.id);
  } else {
    subscriptionsById.set(action.id, action.payloads);
  }

  const messageDispatchPlan = compileMessageDispatch(subscriptionsById);

  // Record any _new_ topics for this subscriber so that we can emit last messages on these topics
  const newTopicsForId = new Set<string>();

  const prevSubsForId = previousSubscriptionsById.get(action.id);
  const prevTopics = new Set(prevSubsForId?.map((sub) => sub.topic) ?? []);
  for (const { topic: newTopic } of action.payloads) {
    if (!prevTopics.has(newTopic)) {
      newTopicsForId.add(newTopic);
    }
  }

  const lastMessageEventByTopic = new Map(prevState.lastMessageEventByTopic);

  for (const topic of prevTopics) {
    // if this topic has no other subscribers, we want to remove it from the lastMessageEventByTopic.
    // This fixes the case where if a panel unsubscribes, triggers playback, and then resubscribes,
    // they won't get this old stale message when they resubscribe again before getting the message
    // at the current time frome seek-backfill.
    if (!messageDispatchPlan.groupsByTopic.has(topic)) {
      lastMessageEventByTopic.delete(topic);
    }
  }

  // Inject the last message on new topics for this subscriber
  const messagesForSubscriber = [];
  for (const topic of newTopicsForId) {
    const msgEvent = lastMessageEventByTopic.get(topic);
    if (msgEvent) {
      messagesForSubscriber.push(msgEvent);
    }
  }

  let newMessagesBySubscriberId;
  if (action.payloads.length === 0 && prevState.public.messageEventsBySubscriberId.has(action.id)) {
    newMessagesBySubscriberId = new Map(prevState.public.messageEventsBySubscriberId);
    newMessagesBySubscriberId.delete(action.id);
  }

  if (messagesForSubscriber.length > 0) {
    newMessagesBySubscriberId = new Map<string, readonly MessageEvent[]>(
      prevState.public.messageEventsBySubscriberId,
    );
    // This should update only the panel that subscribed to the new topic
    newMessagesBySubscriberId.set(action.id, messagesForSubscriber);
  }

  const merged = mergeSubscriptions(Array.from(subscriptionsById.values()).flat());
  // Adding an equivalent panel must not invalidate player caches or restart its subscriptions.
  const subscriptions = subscriptionsEqual(merged, prevState.public.subscriptions)
    ? prevState.public.subscriptions
    : merged;

  const newPublicState = {
    ...prevState.public,
    subscriptions,
    messageEventsBySubscriberId:
      newMessagesBySubscriberId ?? prevState.public.messageEventsBySubscriberId,
  };

  return {
    ...prevState,
    lastMessageEventByTopic,
    subscriptionsById,
    messageDispatchPlan,
    public: newPublicState,
  };
}
// Update with a player state.
// Put messages from the player state into messagesBySubscriberId. Any new topic subscribers, receive
// the last message on a topic.
function updatePlayerStateAction(
  prevState: MessagePipelineInternalState,
  action: UpdatePlayerStateAction,
): MessagePipelineInternalState {
  const messages = action.playerState.activeData?.messages;

  const lastMessageEventByTopic = prevState.lastMessageEventByTopic;
  // A repeated player-state update must not redeliver the same frame. Fresh frames always own
  // fresh arrays, but equivalent subscribers within a frame can safely share those arrays.
  const messagesBySubscriberId =
    messages && messages !== prevState.public.playerState.activeData?.messages
      ? dispatchMessages(messages, prevState.messageDispatchPlan, lastMessageEventByTopic)
      : new Map<string, readonly MessageEvent[]>();

  const newPublicState = {
    ...prevState.public,
    playerState: action.playerState,
    messageEventsBySubscriberId: messagesBySubscriberId,
  };
  const topics = action.playerState.activeData?.topics;
  if (topics !== prevState.public.playerState.activeData?.topics) {
    newPublicState.sortedTopics = topics
      ? [...topics].sort((a, b) => a.name.localeCompare(b.name))
      : [];
  }
  const services = action.playerState.activeData?.services;
  if (services !== prevState.public.playerState.activeData?.services) {
    newPublicState.sortedServices = services
      ? [...services.keys()].sort((a, b) => a.localeCompare(b))
      : [];
  }
  if (
    action.playerState.activeData?.datatypes !== prevState.public.playerState.activeData?.datatypes
  ) {
    newPublicState.datatypes = action.playerState.activeData?.datatypes ?? new Map();
  }

  const capabilities = action.playerState.capabilities;
  const player = prevState.player;
  if (player && !shallowequal(capabilities, prevState.lastCapabilities)) {
    newPublicState.startPlayback = capabilities.includes(PLAYER_CAPABILITIES.playbackControl)
      ? player.startPlayback?.bind(player)
      : undefined;
    newPublicState.playUntil = capabilities.includes(PLAYER_CAPABILITIES.playbackControl)
      ? player.playUntil?.bind(player)
      : undefined;
    newPublicState.pausePlayback = capabilities.includes(PLAYER_CAPABILITIES.playbackControl)
      ? player.pausePlayback?.bind(player)
      : undefined;
    newPublicState.setPlaybackSpeed = capabilities.includes(PLAYER_CAPABILITIES.setSpeed)
      ? player.setPlaybackSpeed?.bind(player)
      : undefined;
    newPublicState.seekPlayback = capabilities.includes(PLAYER_CAPABILITIES.playbackControl)
      ? player.seekPlayback?.bind(player)
      : undefined;
  }

  return {
    ...prevState,
    renderDone: action.renderDone,
    public: newPublicState,
    lastCapabilities: capabilities,
    lastMessageEventByTopic,
  };
}

export function reducer(
  prevState: MessagePipelineInternalState,
  action: MessagePipelineStateAction,
): MessagePipelineInternalState {
  switch (action.type) {
    case "update-player-state":
      return updatePlayerStateAction(prevState, action);
    case "update-subscriber":
      return updateSubscriberAction(prevState, action);

    case "set-publishers": {
      const newPublishersById = { ...prevState.publishersById, [action.id]: action.payloads };

      return {
        ...prevState,
        publishersById: newPublishersById,
        allPublishers: _.flatten(Object.values(newPublishersById)),
      };
    }
  }
}

async function builtinFetch(url: string, opts?: { signal?: AbortSignal }) {
  const response = await fetch(url, opts);
  if (!response.ok) {
    const errMsg = response.statusText;
    throw new Error(`Error ${response.status}${errMsg ? ` (${errMsg})` : ``}`);
  }
  return {
    uri: url,
    data: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get("content-type") ?? undefined,
  };
}
