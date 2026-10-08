// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { MAX_HEIGHT } from "@lichtblick/suite-base/constants/panelLogs";
import { getManagedDocumentStore } from "@lichtblick/suite-base/services/persistence/ManagedPersistence";

export function loadPanelLogsHeight(): number {
  const height = getManagedDocumentStore().get<number>("workspace", "panel-log-height");
  return typeof height === "number" &&
    Number.isFinite(height) &&
    height >= 0 &&
    height <= MAX_HEIGHT
    ? height
    : MAX_HEIGHT;
}
export function savePanelLogsHeight(height: number): void {
  if (!Number.isFinite(height) || height < 0 || height > MAX_HEIGHT) {
    throw new Error("Invalid panel log height");
  }
  void getManagedDocumentStore()
    .commit([{ family: "workspace", key: "panel-log-height", value: height }])
    .catch((error: unknown) => {
      console.error(error);
    });
}
