// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// Dispatch loop from store.ts at b3cd154046d0ad17596faacb6db244b6bb32c3dd.
// Source blob: 67bce14f5be93b7b681bca3b9117ca63255c36ff.
exports.route = function route(messages, subscriberIdsByTopic, lastMessageEventByTopic) {
  const seenTopics = new Set();
  const messagesBySubscriberId = new Map();
  for (const messageEvent of messages) {
    lastMessageEventByTopic.set(messageEvent.topic, messageEvent);
    seenTopics.add(messageEvent.topic);
    const ids = subscriberIdsByTopic.get(messageEvent.topic);
    if (!ids) {
      continue;
    }
    for (const id of ids) {
      const subscriberMessageEvents = messagesBySubscriberId.get(id);
      if (!subscriberMessageEvents) {
        messagesBySubscriberId.set(id, [messageEvent]);
      } else {
        subscriberMessageEvents.push(messageEvent);
      }
    }
  }
  return messagesBySubscriberId;
};
