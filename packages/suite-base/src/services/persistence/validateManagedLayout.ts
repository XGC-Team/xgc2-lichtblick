// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { LayoutData } from "../../context/CurrentLayoutContext/actions";
import type { Layout } from "../ILayoutStorage";

function object(value: unknown): value is Record<string, unknown> {
  return value != undefined && typeof value === "object" && !Array.isArray(value);
}
export function validateManagedLayoutData(value: unknown): asserts value is LayoutData {
  if (
    !object(value) ||
    !object(value.configById) ||
    "savedProps" in value ||
    "state" in value ||
    "data" in value ||
    (value.version != undefined && value.version !== 1)
  ) {
    throw new Error("Invalid current layout data");
  }
}
export function validateManagedLayout(value: unknown): asserts value is Layout {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    !["CREATOR_WRITE", "ORG_READ", "ORG_WRITE"].includes(String(value.permission)) ||
    "data" in value ||
    "state" in value ||
    !object(value.baseline)
  ) {
    throw new Error("Invalid current managed layout");
  }
  validateManagedLayoutData(value.baseline.data);
  if (value.working != undefined) {
    if (!object(value.working)) {
      throw new Error("Invalid managed working copy");
    }
    validateManagedLayoutData(value.working.data);
  }
}
