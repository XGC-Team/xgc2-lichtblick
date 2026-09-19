// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import i18next from "i18next";

import { interactivePreviewEnabled } from "./interactive";
import { OfflineRenderer } from "./renderer";
import {
  assetPath,
  parseEvents,
  parseSnapshot,
  record,
  requireValue,
  verifiedFetch,
  type FramePlan,
} from "./state";

const channel = "xgc2.offline-video";
let renderer: OfflineRenderer | undefined;
let busy = false;
let failed = false;
const interactive = interactivePreviewEnabled(location.search);
const parameters = new URLSearchParams(location.hash.slice(1));
const expectedHash = parameters.get("sha256") ?? "";
const initialization = (async () => {
  requireValue(parent !== window, "Offline renderer must be hosted by the capture worker");
  requireValue(/^[a-f0-9]{64}$/.test(expectedHash), "Expected snapshot digest required");
  const snapshotLocation = parameters.get("snapshot");
  requireValue(snapshotLocation != undefined, "Missing snapshot location");
  const url = new URL(snapshotLocation, location.href);
  const bytes = await verifiedFetch(url, expectedHash, 32 * 1024 * 1024);
  const snapshot = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));
  const base = new URL(".", url);
  const historyBytes = await verifiedFetch(
    new URL(assetPath(snapshot.events), base),
    snapshot.events.sha256,
    snapshot.events.size,
  );
  requireValue(historyBytes.byteLength === snapshot.events.size, "Event history size mismatch");
  const history = parseEvents(JSON.parse(new TextDecoder().decode(historyBytes)), snapshot.topics);
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
  document.getElementById("root")?.remove();
  // Settings metadata uses translation-key fallbacks; no editor UI is mounted.
  await i18next.init({ lng: "en", fallbackLng: "en", resources: {} });
  renderer = new OfflineRenderer(snapshot, history, expectedHash, base);
  return renderer;
})();
// Keep rejection observed even when no host request arrives. It is reported to
// the first valid request rather than turning a blank canvas into a successful frame.
void initialization.catch(() => {
  failed = true;
});

// Installed synchronously, before snapshot/assets finish fetching or iframe load.
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    !record(value) ||
    value.channel !== channel ||
    value.version !== 1 ||
    value.type !== "render-frame" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > 256
  ) {
    return;
  }
  const reply = (type: string, fields: Record<string, unknown>) => {
    parent.postMessage(
      { channel, version: 1, type, requestId: value.requestId, ...fields },
      event.origin,
    );
  };
  if (busy) {
    reply("frame-error", { error: "A frame is already rendering" });
    return;
  }
  busy = true;
  void (async () => {
    try {
      const instance = await initialization;
      requireValue(!failed && record(value.plan), "Recreate invalid/failed renderer");
      const actual = await instance.frame(value.plan as unknown as FramePlan);
      reply("frame-ready", { plan: actual });
    } catch (error) {
      // Interactive preview reports a failed/timed-out scrub frame without
      // tainting the page, so the host can retry or drop it. Strict capture
      // keeps its taint semantics: any frame error fails the whole page.
      failed = failed || !interactive;
      reply("frame-error", {
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
      });
    } finally {
      busy = false;
    }
  })();
});
window.addEventListener("pagehide", () => renderer?.dispose(), { once: true });
