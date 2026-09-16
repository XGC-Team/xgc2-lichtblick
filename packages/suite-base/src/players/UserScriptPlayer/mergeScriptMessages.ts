// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { compare } from "@lichtblick/rostime";
import { MessageEvent } from "@lichtblick/suite-base/players/types";

function compareReceiveTime(a: MessageEvent, b: MessageEvent): number {
  return compare(a.receiveTime, b.receiveTime);
}

/** Preserve stable receive-time ordering without copying an unchanged, sorted frame. */
export function mergeScriptMessages(
  messages: readonly MessageEvent[],
  recomputed: readonly MessageEvent[],
  computed: readonly MessageEvent[],
): readonly MessageEvent[] {
  if (recomputed.length === 0 && computed.length === 0) {
    // Sources normally emit ordered frames, but the old wrapper also sorted
    // out-of-order input. Do not turn the no-script path into an ordering change.
    for (let i = 1; i < messages.length; i++) {
      if (compareReceiveTime(messages[i - 1]!, messages[i]!) > 0) {
        return messages.slice().sort(compareReceiveTime);
      }
    }
    return messages;
  }

  // Stable sort retains the old tie order: input, recomputed, then computed.
  // Pass arrays to concat, not spread arguments, so large frames remain safe.
  return messages.concat(recomputed, computed).sort(compareReceiveTime);
}
