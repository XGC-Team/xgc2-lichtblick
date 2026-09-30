/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { captureView, type CaptureRenderer } from "./captureView";

function renderer() {
  const calls: string[] = [];
  const listeners = new Set<(time: bigint) => void>();
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  const value: CaptureRenderer = {
    gl: { domElement: canvas, getContext: () => ({ isContextLost: () => false }) },
    canvasVisibility: () => "visible",
    queueAnimationFrame: () => {
      calls.push("queue");
    },
    animationFrame: () => {
      calls.push("draw");
      for (const listener of listeners) {
        listener(12300000000n);
      }
    },
    settleVideoDecodes: async () => {
      calls.push("decode");
    },
    addListener: (_, listener) => {
      listeners.add(listener);
    },
    removeListener: (_, listener) => {
      listeners.delete(listener);
    },
  };
  return { value, calls, listeners };
}

describe("view pixel capture", () => {
  beforeEach(() => {
    jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
        type: "image/png",
      });
      Object.defineProperty(blob, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
      callback(blob);
    });
  });

  it("copies after camera decoding and a fresh draw at renderer time", async () => {
    const { value, calls, listeners } = renderer();
    const result = await captureView(value, new AbortController().signal);
    expect(calls).toEqual(["queue", "draw", "decode", "queue", "draw"]);
    expect(result).toMatchObject({ renderedTimeNs: "12300000000" });
    expect(result.png.byteLength).toBe(8);
    expect(listeners.size).toBe(0);
  });

  it("fails for hidden or lost-context views before requesting a draw", async () => {
    const hidden = renderer();
    hidden.value.canvasVisibility = () => "hidden";
    await expect(captureView(hidden.value, new AbortController().signal)).rejects.toThrow("hidden");
    expect(hidden.calls).toEqual([]);
    const lost = renderer();
    lost.value.gl.getContext = () => ({ isContextLost: () => true });
    await expect(captureView(lost.value, new AbortController().signal)).rejects.toThrow(
      "context is lost",
    );
  });

  it.each([
    "decode",
    "frame",
  ])("cancels a stalled %s without leaving frame listeners", async (stage) => {
    const { value, listeners } = renderer();
    if (stage === "decode") {
      value.settleVideoDecodes = async () => {
        await new Promise(() => {});
      };
    } else {
      value.animationFrame = () => {};
    }
    const abort = new AbortController();
    const pending = captureView(value, abort.signal);
    await Promise.resolve();
    abort.abort();
    await expect(pending).rejects.toThrow(/canceled|aborted/);
    expect(listeners.size).toBe(0);
  });
});
