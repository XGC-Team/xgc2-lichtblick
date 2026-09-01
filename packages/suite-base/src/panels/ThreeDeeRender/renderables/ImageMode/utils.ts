// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  LOWER_BRIGHTNESS_LIMIT,
  LOWER_CONTRAST_LIMIT,
  MAX_BRIGHTNESS,
  MAX_CONTRAST,
  MIN_BRIGHTNESS,
  MIN_CONTRAST,
  UPPER_BRIGHTNESS_LIMIT,
  UPPER_CONTRAST_LIMIT,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/ImageMode/constants";

export const IMAGE_MODE_MAX_DECODE_WIDTH = 1280;

/**
 * Decode only the pixels the live Image viewport can display. The source and
 * recording stay full resolution; this bounds the per-frame ImageBitmap and
 * WebGL texture upload that otherwise stalls the host browser on 4K video.
 */
export function imageModeDecodeWidth(canvasWidth: number, pixelRatio: number): number {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const requested = Number.isFinite(canvasWidth) && canvasWidth > 0
    ? Math.ceil(canvasWidth * ratio)
    : IMAGE_MODE_MAX_DECODE_WIDTH;
  return Math.min(IMAGE_MODE_MAX_DECODE_WIDTH, Math.max(1, requested));
}

function mapRange(
  value: number,
  inputMin: number,
  inputMax: number,
  outputMin: number,
  outputMax: number,
): number {
  const clamped = Math.min(Math.max(value, inputMin), inputMax);
  return ((clamped - inputMin) / (inputMax - inputMin)) * (outputMax - outputMin) + outputMin;
}

export function clampBrightness(value: number): number {
  return mapRange(
    value,
    MIN_BRIGHTNESS,
    MAX_BRIGHTNESS,
    LOWER_BRIGHTNESS_LIMIT,
    UPPER_BRIGHTNESS_LIMIT,
  );
}

export function clampContrast(value: number): number {
  return mapRange(value, MIN_CONTRAST, MAX_CONTRAST, LOWER_CONTRAST_LIMIT, UPPER_CONTRAST_LIMIT);
}
