// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

/** Synchronous readback is the completion barrier. No timer/rAF is a GPU fence. */
export function readFramePixels(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): Uint8ClampedArray {
  if (gl.isContextLost() || gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
    throw new Error("WebGL context or drawing-buffer dimensions changed");
  }
  const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null;
  const alignment = gl.getParameter(gl.PACK_ALIGNMENT) as number;
  const rowLength = gl.getParameter(gl.PACK_ROW_LENGTH) as number;
  const skipRows = gl.getParameter(gl.PACK_SKIP_ROWS) as number;
  const skipPixels = gl.getParameter(gl.PACK_SKIP_PIXELS) as number;
  const pixels = new Uint8Array(width * height * 4);
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    gl.finish();
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) {
      throw new Error("WebGL readback failed");
    }
  } finally {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    gl.pixelStorei(gl.PACK_ALIGNMENT, alignment);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, rowLength);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, skipRows);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, skipPixels);
  }
  return flipRows(pixels, width, height);
}

export function flipRows(source: Uint8Array, width: number, height: number): Uint8ClampedArray {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 16384 || height > 16384 || source.byteLength !== width * height * 4) {
    throw new Error("Invalid RGBA buffer");
  }
  const result = new Uint8ClampedArray(source.byteLength);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    result.set(source.subarray(y * stride, (y + 1) * stride), (height - y - 1) * stride);
  }
  return result;
}
