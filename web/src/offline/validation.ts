// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

export type Asset = { path: string; sha256: string; size: number };

export function requireValue(value: unknown, message: string): asserts value {
  if (value == undefined || value === false || value === 0 || value === "") {
    throw new Error(message);
  }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}
export function nanos(value: unknown): bigint {
  requireValue(
    typeof value === "string" && /^(0|[1-9]\d{0,29})$/.test(value),
    "Invalid nanosecond timestamp",
  );
  return BigInt(value);
}
export function assetPath(asset: Asset): string {
  requireValue(
    record(asset) &&
      /^[a-f0-9]{64}$/.test(asset.sha256) &&
      /^assets\/[a-f0-9]{64}\.(json|jpg|png|dae)$/.test(asset.path) &&
      asset.path.split("/")[1]?.startsWith(asset.sha256 + ".") === true &&
      Number.isSafeInteger(asset.size) &&
      asset.size > 0,
    "Invalid asset reference",
  );
  return asset.path;
}
