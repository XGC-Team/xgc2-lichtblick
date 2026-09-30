// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

export const VIEW_CAPTURE_CHANNEL = "xgc-lichtblick-view-capture";
export const VIEW_CAPTURE_VERSION = 1;
export const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
export type CaptureView = "3d" | "ar";
export type ViewCaptureResult = {
  png: ArrayBuffer;
  renderedTimeNs: string;
  viewPanelId: string;
};
export type ViewCaptureProvider = {
  panelId: string;
  view: CaptureView;
  capture: (signal: AbortSignal) => Promise<Omit<ViewCaptureResult, "viewPanelId">>;
};
type Command = {
  channel: typeof VIEW_CAPTURE_CHANNEL;
  version: typeof VIEW_CAPTURE_VERSION;
  sender: "host";
  type: "capture" | "cancel";
  requestId: string;
  view?: CaptureView;
  viewPanelId?: string;
  timeoutMs?: number;
};
function command(value: unknown): Command | undefined {
  if (typeof value !== "object" || value == undefined || Array.isArray(value)) {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  if (
    data.channel !== VIEW_CAPTURE_CHANNEL ||
    data.version !== VIEW_CAPTURE_VERSION ||
    data.sender !== "host" ||
    typeof data.requestId !== "string" ||
    !/^[a-f0-9]{32}$/.test(data.requestId)
  ) {
    return undefined;
  }
  const keys =
    data.type === "cancel"
      ? ["channel", "version", "sender", "type", "requestId"]
      : ["channel", "version", "sender", "type", "requestId", "view", "viewPanelId", "timeoutMs"];
  if (Object.keys(data).some((key) => !keys.includes(key))) {
    return undefined;
  }
  if (data.type === "capture") {
    if (data.view !== "3d" && data.view !== "ar") {
      return undefined;
    }
    if (
      data.viewPanelId != undefined &&
      (typeof data.viewPanelId !== "string" || data.viewPanelId.length > 256)
    ) {
      return undefined;
    }
    if (
      typeof data.timeoutMs !== "number" ||
      !Number.isInteger(data.timeoutMs) ||
      data.timeoutMs < 1 ||
      data.timeoutMs > 60000
    ) {
      return undefined;
    }
  } else if (data.type !== "cancel") {
    return undefined;
  }
  return data as Command;
}

// Underlying browser encoders may not be cancelable. Their eventual result is
// consumed but cannot keep a canceled request or provider lease alive.
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw new Error("View capture canceled or timed out");
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new Error("View capture canceled or timed out"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

// Scoped providers are registered by mounted renderers and removed on dispose.
// Selection never assumes default layout IDs or takes the first canvas.
export class EmbeddedViewCapture {
  readonly #providers = new Set<ViewCaptureProvider>();
  readonly #busy = new Set<ViewCaptureProvider>();

  public register(provider: ViewCaptureProvider): () => void {
    this.#providers.add(provider);
    return () => {
      this.#providers.delete(provider);
      this.#busy.delete(provider);
    };
  }
  public async capture(
    view: CaptureView,
    panelId: string | undefined,
    signal: AbortSignal,
  ): Promise<ViewCaptureResult> {
    signal.throwIfAborted();
    const providers = [...this.#providers].filter(
      (provider) => provider.view === view && (!panelId || provider.panelId === panelId),
    );
    if (providers.length !== 1) {
      throw new Error(
        providers.length === 0
          ? "Requested view is not mounted or ready"
          : "Multiple matching views; specify viewPanelId",
      );
    }
    const provider = providers[0]!;
    if (this.#busy.has(provider)) {
      throw new Error("View capture is already in progress");
    }
    this.#busy.add(provider);
    try {
      const result = await abortable(provider.capture(signal), signal);
      signal.throwIfAborted();
      if (!this.#providers.has(provider)) {
        throw new Error("View was disposed during capture");
      }
      if (result.png.byteLength < 8 || result.png.byteLength > MAX_CAPTURE_BYTES) {
        throw new Error("Invalid capture image size");
      }
      return { ...result, viewPanelId: provider.panelId };
    } finally {
      this.#busy.delete(provider);
    }
  }
  public connect(parent: Window, origin: string, receiver: Window = window): () => void {
    const pending = new Map<string, AbortController>();
    // Replayed IDs cannot create another capture during this connection.
    const seen = new Set<string>();
    let connected = true;
    const reply = (
      requestId: string,
      data: Record<string, unknown>,
      transfer: Transferable[] = [],
    ) => {
      if (connected) {
        parent.postMessage(
          {
            channel: VIEW_CAPTURE_CHANNEL,
            version: VIEW_CAPTURE_VERSION,
            sender: "viewer",
            requestId,
            ...data,
          },
          origin,
          transfer,
        );
      }
    };
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== parent || event.origin !== origin) {
        return;
      }
      const request = command(event.data);
      if (!request) {
        return;
      }
      if (request.type === "cancel") {
        pending.get(request.requestId)?.abort();
        return;
      }
      if (seen.has(request.requestId)) {
        return;
      }
      // A bounded connection window also bounds replay bookkeeping.
      if (seen.size >= 4096 || pending.size >= 8) {
        reply(request.requestId, {
          type: "error",
          error: "Capture request capacity exceeded; reload the viewer",
        });
        return;
      }
      seen.add(request.requestId);
      const abort = new AbortController();
      pending.set(request.requestId, abort);
      const timer = receiver.setTimeout(() => {
        abort.abort();
      }, request.timeoutMs);
      void this.capture(request.view!, request.viewPanelId, abort.signal)
        .then((result) => {
          if (!abort.signal.aborted) {
            reply(request.requestId, { type: "captured", ...result }, [result.png]);
          }
        })
        .catch((error: unknown) => {
          reply(request.requestId, {
            type: "error",
            error: (error instanceof Error ? error.message : "Capture failed").slice(0, 512),
          });
        })
        .finally(() => {
          receiver.clearTimeout(timer);
          pending.delete(request.requestId);
        });
    };
    receiver.addEventListener("message", listener);
    return () => {
      connected = false;
      receiver.removeEventListener("message", listener);
      for (const abort of pending.values()) {
        abort.abort();
      }
      pending.clear();
      seen.clear();
    };
  }
}
export const embeddedViewCapture = new EmbeddedViewCapture();
