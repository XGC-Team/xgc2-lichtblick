// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { SceneEnvelope } from "./types";

export function canRetrySync(envelope: SceneEnvelope): boolean {
  if (envelope.synchronized !== false) {
    return false;
  }
  if (envelope.syncRetryable === false) {
    return false;
  }
  if (envelope.syncRetryable === true) {
    return true;
  }
  const lagged = envelope.consumers.some(
    (consumer) => consumer.epoch !== envelope.epoch || consumer.revision !== envelope.revision,
  );
  if (lagged) {
    return true;
  }
  const missing = envelope.consumers.filter(
    (consumer) =>
      consumer.epoch === envelope.epoch &&
      consumer.revision === envelope.revision &&
      !consumer.applied,
  );
  if (missing.length === 0) {
    return false;
  }
  return missing.some((consumer) => consumer.capability !== "unsupported");
}
