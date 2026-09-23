// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

/** An image a renderable can present: decoded bitmaps, raw pixels or a decoder's own frame. */
export type PresentableImage = ImageBitmap | ImageData | VideoFrame;

export function isVideoFrame(value: unknown): value is VideoFrame {
  // VideoFrame is absent from browsers without WebCodecs (and from jsdom).
  return typeof VideoFrame !== "undefined" && value instanceof VideoFrame;
}

/** Presented pixel dimensions; a VideoFrame reports them as its display size. */
export function presentableImageSize(image: PresentableImage): { width: number; height: number } {
  return isVideoFrame(image)
    ? { width: image.displayWidth, height: image.displayHeight }
    : { width: image.width, height: image.height };
}

/**
 * A texture uploaded straight from a WebCodecs VideoFrame, so a decoded picture that needs no
 * resize reaches the GPU without an intermediate ImageBitmap copy.
 *
 * three r156 has no VideoFrame support of its own. `isVideoTexture` selects its `texImage2D`
 * upload, which takes the size from the source (the `texStorage2D` path needs `width`/`height`
 * properties that a VideoFrame does not have), and `update()` is a no-op because the owner assigns
 * each new frame and sets `needsUpdate` itself. Rows arrive top first, as for an ImageBitmap
 * (where UNPACK_FLIP_Y is ignored), so `flipY` stays off and UVs are shared with bitmap textures.
 * Filters and colour space match the renderable's bitmap textures.
 */
export class VideoFrameTexture extends THREE.Texture {
  public readonly isVideoTexture = true;

  public constructor(frame: VideoFrame) {
    super(
      frame,
      THREE.UVMapping,
      THREE.ClampToEdgeWrapping,
      THREE.ClampToEdgeWrapping,
      THREE.NearestFilter,
      THREE.LinearFilter,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.generateMipmaps = false;
    this.flipY = false;
    // Color space needs to be set to LinearSRGBColorSpace for correct color rendering on custom Shader
    this.colorSpace = THREE.LinearSRGBColorSpace;
    this.needsUpdate = true;
  }

  public currentFrame(): VideoFrame {
    return this.image as VideoFrame;
  }

  /** Called by three for video textures before each render; frames are pushed, not polled. */
  public update(): void {}
}
