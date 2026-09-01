// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  INITIAL_BRIGHTNESS,
  INITIAL_CONTRAST,
  LOWER_BRIGHTNESS_LIMIT,
  LOWER_CONTRAST_LIMIT,
  MAX_BRIGHTNESS,
  MAX_CONTRAST,
  MIN_BRIGHTNESS,
  MIN_CONTRAST,
  UPPER_BRIGHTNESS_LIMIT,
  UPPER_CONTRAST_LIMIT,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/ImageMode/constants";
import { BasicBuilder } from "@lichtblick/test-builders";

import {
  IMAGE_MODE_MAX_DECODE_WIDTH,
  clampBrightness,
  clampContrast,
  imageModeDecodeWidth,
} from "./utils";

describe("imageModeDecodeWidth", () => {
  it("matches the live viewport without uploading a 4K texture", () => {
    expect(imageModeDecodeWidth(1280, 1)).toBe(1280);
    expect(imageModeDecodeWidth(640, 2)).toBe(1280);
    expect(imageModeDecodeWidth(3840, 1)).toBe(IMAGE_MODE_MAX_DECODE_WIDTH);
    expect(imageModeDecodeWidth(1920, 2)).toBe(IMAGE_MODE_MAX_DECODE_WIDTH);
  });

  it("uses the bounded live-preview width before the canvas is measured", () => {
    expect(imageModeDecodeWidth(0, 1)).toBe(IMAGE_MODE_MAX_DECODE_WIDTH);
    expect(imageModeDecodeWidth(Number.NaN, Number.NaN)).toBe(IMAGE_MODE_MAX_DECODE_WIDTH);
  });
});

describe("clampBrightness", () => {
  it("maps brightness within limits", () => {
    const randomBrightness = BasicBuilder.number({ min: MIN_BRIGHTNESS, max: MAX_BRIGHTNESS });
    expect(clampBrightness(randomBrightness)).toBeGreaterThanOrEqual(LOWER_BRIGHTNESS_LIMIT);
    expect(clampBrightness(randomBrightness)).toBeLessThanOrEqual(UPPER_BRIGHTNESS_LIMIT);
  });

  it("clamps brightness below minimum", () => {
    const lowRandomBrightness = BasicBuilder.number({
      min: MIN_BRIGHTNESS - 100,
      max: MIN_BRIGHTNESS - 1,
    });
    const result = clampBrightness(lowRandomBrightness);
    expect(result).toBe(LOWER_BRIGHTNESS_LIMIT);
  });

  it("clamps brightness above maximum", () => {
    const highRandomBrightness = BasicBuilder.number({
      min: MAX_BRIGHTNESS + 1,
      max: MAX_BRIGHTNESS + 100,
    });
    const result = clampBrightness(highRandomBrightness);
    expect(result).toBe(UPPER_BRIGHTNESS_LIMIT);
  });
});

describe("clampContrast", () => {
  it("maps contrast within limits", () => {
    const randomContrast = BasicBuilder.number({ min: MIN_CONTRAST, max: MAX_CONTRAST });
    expect(clampContrast(randomContrast)).toBeGreaterThanOrEqual(LOWER_CONTRAST_LIMIT);
    expect(clampContrast(randomContrast)).toBeLessThanOrEqual(UPPER_CONTRAST_LIMIT);
  });

  it("clamps contrast below minimum", () => {
    const lowRandomContrast = BasicBuilder.number({
      min: MIN_CONTRAST - 100,
      max: MIN_CONTRAST - 1,
    });
    const result = clampContrast(lowRandomContrast);
    expect(result).toBe(LOWER_CONTRAST_LIMIT);
  });

  it("clamps contrast above maximum", () => {
    const highRandomContrast = BasicBuilder.number({
      min: MAX_CONTRAST + 1,
      max: MAX_CONTRAST + 100,
    });
    const result = clampContrast(highRandomContrast);
    expect(result).toBe(UPPER_CONTRAST_LIMIT);
  });
});

describe("brightness and contrast limits", () => {
  it("guarantee that brightness are ok", () => {
    expect(MIN_BRIGHTNESS).toBeLessThan(MAX_BRIGHTNESS);
    expect(INITIAL_BRIGHTNESS).toBeGreaterThanOrEqual(MIN_BRIGHTNESS);
    expect(INITIAL_BRIGHTNESS).toBeLessThanOrEqual(MAX_BRIGHTNESS);
    expect(LOWER_BRIGHTNESS_LIMIT).toBeLessThan(UPPER_BRIGHTNESS_LIMIT);
  });

  it("guarantee that contrast are ok", () => {
    expect(MIN_CONTRAST).toBeLessThan(MAX_CONTRAST);
    expect(INITIAL_CONTRAST).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(INITIAL_CONTRAST).toBeLessThanOrEqual(MAX_CONTRAST);
    expect(LOWER_CONTRAST_LIMIT).toBeLessThan(UPPER_CONTRAST_LIMIT);
  });
});
