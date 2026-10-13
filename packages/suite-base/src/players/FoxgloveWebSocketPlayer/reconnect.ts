// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

/** Full jitter for one peer: 250 ms initially, doubling to a 30 second cap. */
export function reconnectDelay(attempt: number, jitter: number): number {
  return Math.floor(jitter * Math.min(30_000, 250 * 2 ** Math.min(attempt, 7)));
}
