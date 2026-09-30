// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { MAX_CAPTURE_BYTES, abortable } from "../../components/EmbeddedViewCapture";

// Structural renderer boundary keeps pixel-copy and cancellation tests free of
// WebGL, React, ROS transports, and the full renderer dependency graph.
export type CaptureRenderer = {
  gl: { domElement: HTMLCanvasElement; getContext: () => { isContextLost: () => boolean } };
  canvasVisibility: () => "visible" | "hidden";
  animationFrame: () => void;
  queueAnimationFrame: () => void;
  settleVideoDecodes: () => Promise<void>;
  addListener: (event: "endFrame", listener: (time: bigint) => void) => unknown;
  removeListener: (event: "endFrame", listener: (time: bigint) => void) => unknown;
};
export async function captureView(
  renderer: CaptureRenderer,
  signal: AbortSignal,
): Promise<{ png: ArrayBuffer; renderedTimeNs: string }> {
  const ready = () => {
    signal.throwIfAborted();
    if (renderer.canvasVisibility() !== "visible") {
      throw new Error("View is hidden or parked; make the view visible before capture");
    }
    if (renderer.gl.getContext().isContextLost()) {
      throw new Error("View WebGL context is lost");
    }
    const canvas = renderer.gl.domElement;
    if (
      canvas.width < 1 ||
      canvas.height < 1 ||
      canvas.width > 8192 ||
      canvas.height > 8192 ||
      canvas.width * canvas.height > 16 * 1024 * 1024
    ) {
      throw new Error("View has invalid capture dimensions");
    }
  };
  ready();
  // Flush scene updates, wait for camera/video decoding, then copy at the end
  // of a fresh draw. Copying an arbitrary preserved WebGL buffer is unsafe.
  renderer.queueAnimationFrame();
  renderer.animationFrame();
  await abortable(renderer.settleVideoDecodes(), signal);
  ready();
  let remove = () => {};
  const frame = new Promise<{ canvas: HTMLCanvasElement; renderedTimeNs: string }>(
    (resolve, reject) => {
      const listener = (time: bigint) => {
        try {
          ready();
          const source = renderer.gl.domElement;
          const canvas = source.ownerDocument.createElement("canvas");
          canvas.width = source.width;
          canvas.height = source.height;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("Cannot create PNG capture canvas");
          }
          context.drawImage(source, 0, 0);
          resolve({ canvas, renderedTimeNs: time.toString() });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          remove();
        }
      };
      remove = () => {
        renderer.removeListener("endFrame", listener);
      };
      renderer.addListener("endFrame", listener);
      try {
        renderer.queueAnimationFrame();
        renderer.animationFrame();
      } catch (error) {
        remove();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
  let copied: { canvas: HTMLCanvasElement; renderedTimeNs: string };
  try {
    copied = await abortable(frame, signal);
  } finally {
    remove();
  }
  const blob = await abortable(
    new Promise<Blob>((resolve, reject) => {
      copied.canvas.toBlob((value) => {
        if (value) {
          resolve(value);
        } else {
          reject(new Error("PNG encoding failed"));
        }
      }, "image/png");
    }),
    signal,
  );
  if (blob.size > MAX_CAPTURE_BYTES) {
    throw new Error("PNG exceeds 16 MiB");
  }
  const png = await abortable(blob.arrayBuffer(), signal);
  signal.throwIfAborted();
  return { png, renderedTimeNs: copied.renderedTimeNs };
}
