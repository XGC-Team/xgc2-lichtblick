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

export const IMAGE_MODE_MAX_DECODE_WIDTH = 1920;
export const IMAGE_MODE_COARSE_DECODE_WIDTH = 1280;
/** WebGL1 phones often advertise MAX_TEXTURE_SIZE 2048; never decode above this. */
export const IMAGE_MODE_MAX_TEXTURE_WIDTH = 2048;

export type ImageModePreviewHints = {
  pointerCoarse?: boolean;
  anyPointerCoarse?: boolean;
  maxTouchPoints?: number;
};

// The budget is read for every image message. A MediaQueryList keeps `matches` current as input
// devices change, so parse and register each query once instead of once per video frame.
let queriedMatchMedia: typeof matchMedia | undefined;
const mediaQueryLists = new Map<string, MediaQueryList | undefined>();

function mediaMatches(query: string): boolean {
  if (typeof matchMedia !== "function") {
    return false;
  }
  if (queriedMatchMedia !== matchMedia) {
    queriedMatchMedia = matchMedia;
    mediaQueryLists.clear();
  }
  if (!mediaQueryLists.has(query)) {
    let list: MediaQueryList | undefined;
    try {
      list = matchMedia(query);
    } catch {
      list = undefined;
    }
    mediaQueryLists.set(query, list);
  }
  return mediaQueryLists.get(query)?.matches === true;
}

function defaultPreviewHints(): ImageModePreviewHints {
  const maxTouchPoints = typeof navigator === "undefined" ? 0 : Number(navigator.maxTouchPoints);
  return {
    pointerCoarse: mediaMatches("(pointer: coarse)"),
    anyPointerCoarse: mediaMatches("(any-pointer: coarse)"),
    maxTouchPoints: Number.isFinite(maxTouchPoints) ? maxTouchPoints : 0,
  };
}

/** Phone / tablet ImageMode budget. Desktop stays at {@link IMAGE_MODE_MAX_DECODE_WIDTH}. */
export function imageModePreviewBudget(
  hints: ImageModePreviewHints = defaultPreviewHints(),
): number {
  const touchPoints = hints.maxTouchPoints ?? 0;
  if (hints.pointerCoarse === true || hints.anyPointerCoarse === true || touchPoints > 0) {
    return IMAGE_MODE_COARSE_DECODE_WIDTH;
  }
  return IMAGE_MODE_MAX_DECODE_WIDTH;
}

/** Keep detail available for image-panel zoom, independent of docked pane size. */
export function imageModeDecodeWidth(
  sourceWidth?: number,
  maxWidth = IMAGE_MODE_MAX_DECODE_WIDTH,
): number {
  const requested =
    maxWidth > 0 && Number.isFinite(maxWidth)
      ? Math.max(1, Math.floor(maxWidth))
      : IMAGE_MODE_MAX_DECODE_WIDTH;
  const budget = Math.min(requested, IMAGE_MODE_MAX_TEXTURE_WIDTH);
  return sourceWidth != undefined && Number.isFinite(sourceWidth) && sourceWidth > 0
    ? Math.min(budget, Math.max(1, Math.floor(sourceWidth)))
    : budget;
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
