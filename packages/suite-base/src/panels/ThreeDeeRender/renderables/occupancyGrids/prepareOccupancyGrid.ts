// SPDX-License-Identifier: MPL-2.0
import {
  normalizeHeader,
  normalizePose,
  normalizeInt8Array,
  normalizeTime,
} from "../../normalizeMessages";
import { SRGBToLinear, stringToRgba } from "../../color";
import type { ColorRGBA, OccupancyGrid } from "../../ros";
import type { PartialMessage } from "../../SceneExtension";
import type { LayerSettingsOccupancyGrid } from "../OccupancyGrids";

export type NormalizedOccupancyGrid = Omit<OccupancyGrid, "data"> & { data: Int8Array };

export type PreparedOccupancyGrid = {
  occupancyGrid: NormalizedOccupancyGrid;
  rgba: Uint8ClampedArray;
};

// A single 1024-byte table derives from this consumer's color settings. Signed cells are
// interpreted only after normalizeInt8Array; no arbitrary input is masked into an index.
export function prepareOccupancyGrid(
  message: unknown,
  palette: Uint8ClampedArray,
  onAllocated?: (arrays: readonly ArrayBufferView[]) => void,
): PreparedOccupancyGrid {
  if (!(palette instanceof Uint8ClampedArray) || palette.length !== 1024) {
    throw new Error("Invalid OccupancyGrid color table");
  }
  const occupancyGrid = normalizeOccupancyGrid(message as PartialMessage<OccupancyGrid>);
  const size = occupancyGrid.info.width * occupancyGrid.info.height;
  if (occupancyGrid.data.length !== size) {
    throw new Error(
      `OccupancyGrid data length (${occupancyGrid.data.length}) is not equal to width ${occupancyGrid.info.width} * height ${occupancyGrid.info.height}`,
    );
  }
  const rgba = new Uint8ClampedArray(size * 4);
  onAllocated?.([occupancyGrid.data, palette, rgba]);
  for (let i = 0; i < size; i++) {
    const offset = i * 4;
    const color = (occupancyGrid.data[i]! & 255) * 4;
    rgba[offset] = palette[color]!;
    rgba[offset + 1] = palette[color + 1]!;
    rgba[offset + 2] = palette[color + 2]!;
    rgba[offset + 3] = palette[color + 3]!;
  }
  return { occupancyGrid, rgba };
}

// Material/pose-only settings do not participate in CPU color preparation. Custom alpha
// is intentionally ignored by the original custom branch, unlike the other palettes.
export function occupancyGridColorKey(settings: LayerSettingsOccupancyGrid): string {
  return settings.colorMode === "custom"
    ? JSON.stringify([
        settings.colorMode,
        settings.minColor,
        settings.maxColor,
        settings.unknownColor,
        settings.invalidColor,
      ])!
    : JSON.stringify([settings.colorMode, settings.alpha])!; // Fresh arrays always serialize.
}

const tempColor = { r: 0, g: 0, b: 0, a: 0 };
const tempUnknownColor = { r: 0, g: 0, b: 0, a: 0 };
const tempInvalidColor = { r: 0, g: 0, b: 0, a: 0 };
const tempMinColor = { r: 0, g: 0, b: 0, a: 0 };
const tempMaxColor = { r: 0, g: 0, b: 0, a: 0 };

export function createOccupancyGridPalette(
  settings: LayerSettingsOccupancyGrid,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(256 * 4);
  stringToRgba(tempMinColor, settings.minColor);
  stringToRgba(tempMaxColor, settings.maxColor);
  stringToRgba(tempUnknownColor, settings.unknownColor);
  stringToRgba(tempInvalidColor, settings.invalidColor);

  srgbToLinearUint8(tempMinColor);
  srgbToLinearUint8(tempMaxColor);
  srgbToLinearUint8(tempUnknownColor);
  srgbToLinearUint8(tempInvalidColor);

  for (let i = 0; i < 256; i++) {
    const value = i < 128 ? i : i - 256;
    const offset = i * 4;
    if (settings.colorMode === "custom") {
      if (value === -1) {
        // Unknown (-1)
        rgba[offset + 0] = tempUnknownColor.r;
        rgba[offset + 1] = tempUnknownColor.g;
        rgba[offset + 2] = tempUnknownColor.b;
        rgba[offset + 3] = tempUnknownColor.a;
      } else if (value >= 0 && value <= 100) {
        // Valid [0-100]
        const frac = value / 100;

        rgba[offset + 0] = tempMinColor.r + (tempMaxColor.r - tempMinColor.r) * frac;
        rgba[offset + 1] = tempMinColor.g + (tempMaxColor.g - tempMinColor.g) * frac;
        rgba[offset + 2] = tempMinColor.b + (tempMaxColor.b - tempMinColor.b) * frac;
        rgba[offset + 3] = tempMinColor.a + (tempMaxColor.a - tempMinColor.a) * frac;
      } else {
        // Invalid (< -1 or > 100)
        rgba[offset + 0] = tempInvalidColor.r;
        rgba[offset + 1] = tempInvalidColor.g;
        rgba[offset + 2] = tempInvalidColor.b;
        rgba[offset + 3] = tempInvalidColor.a;
      }
    } else {
      paletteColorCached(tempColor, value, settings.colorMode);
      rgba[offset + 0] = tempColor.r;
      rgba[offset + 1] = tempColor.g;
      rgba[offset + 2] = tempColor.b;
      rgba[offset + 3] = tempColor.a * settings.alpha;
    }
  }

  return rgba;
}

export function occupancyGridHasTransparency(settings: LayerSettingsOccupancyGrid): boolean {
  if (settings.colorMode === "custom") {
    stringToRgba(tempMinColor, settings.minColor);
    stringToRgba(tempMaxColor, settings.maxColor);
    stringToRgba(tempUnknownColor, settings.unknownColor);
    stringToRgba(tempInvalidColor, settings.invalidColor);
    return (
      tempMinColor.a < 1 || tempMaxColor.a < 1 || tempInvalidColor.a < 1 || tempUnknownColor.a < 1
    );
  } else {
    return true;
  }
}

function srgbToLinearUint8(color: ColorRGBA): void {
  color.r = Math.trunc(SRGBToLinear(color.r) * 255);
  color.g = Math.trunc(SRGBToLinear(color.g) * 255);
  color.b = Math.trunc(SRGBToLinear(color.b) * 255);
  color.a = Math.trunc(color.a * 255);
}

export function normalizeOccupancyGrid(
  message: PartialMessage<OccupancyGrid>,
): NormalizedOccupancyGrid {
  const info = message.info ?? {};

  return {
    header: normalizeHeader(message.header),
    info: {
      map_load_time: normalizeTime(info.map_load_time),
      resolution: info.resolution ?? 0,
      width: info.width ?? 0,
      height: info.height ?? 0,
      origin: normalizePose(info.origin),
    },
    data: normalizeInt8Array(message.data),
  };
}

let costmapPalette: [number, number, number, number][] | undefined;
let mapPalette: [number, number, number, number][] | undefined;
let rawPalette: [number, number, number, number][] | undefined;

/**
 * Maps the value to a color using the given palette that is cached after initial use.
 * @param output - RGBA color output of the given value using the palette in the colormode
 * @param value - Int8 or Uint8 value to map to a color
 * @param paletteColorMode - "costmap", "map", or "raw" these are the predefined palette colormodes. Their palette will be used to determine the output color
 */
function paletteColorCached(
  output: ColorRGBA,
  value: number,
  paletteColorMode: "costmap" | "map" | "raw",
) {
  const unsignedValue = value >= 0 ? value : value + 256;
  if (unsignedValue < 0 || unsignedValue > 255) {
    output.r = 0;
    output.g = 0;
    output.b = 0;
    output.a = 0;
  }

  let palette: [number, number, number, number][] | undefined;
  switch (paletteColorMode) {
    case "costmap":
      costmapPalette ??= createCostmapPalette();
      palette = costmapPalette;
      break;
    case "map":
      mapPalette ??= createMapPalette();
      palette = mapPalette;
      break;
    case "raw":
      rawPalette ??= createRawPalette();
      palette = rawPalette;
      break;
    default:
      // Default to raw palette if unknown colormode, the user will have an error already in the settings
      rawPalette ??= createRawPalette();
      palette = rawPalette;
  }

  const colorRaw = palette[Math.trunc(unsignedValue)]!;
  output.r = colorRaw[0];
  output.g = colorRaw[1];
  output.b = colorRaw[2];
  output.a = colorRaw[3];
}

// Based off of rviz map implementation
// https://github.com/ros-visualization/rviz/blob/1f622b8c95b8e188841b5505db2f97394d3e9c6c/src/rviz/default_plugin/map_display.cpp#L284
function createMapPalette() {
  let index = 0;
  const palette = new Array(256).fill([0, 0, 0, 0]);

  // Standard gray map palette values
  for (let i = 0; i <= 100; i++) {
    const v = Math.trunc(255 - (255 * i) / 100);
    palette[index++] = [v, v, v, 255];
  }

  // illegal positive values in green
  for (let i = 101; i <= 127; i++) {
    palette[index++] = [0, 255, 0, 255];
  }

  // illegal negative (char) values in shades of red/yellow
  for (let i = 128; i <= 254; i++) {
    palette[index++] = [255, Math.trunc((255 * (i - 128)) / (254 - 128)), 0, 255];
  }

  // legal -1 value is tasteful blueish greenish grayish color
  palette[index++] = [112, 137, 134, 255];
  return palette;
}

// Based off of rviz costmap implementation
// https://github.com/ros-visualization/rviz/blob/1f622b8c95b8e188841b5505db2f97394d3e9c6c/src/rviz/default_plugin/map_display.cpp#L322
function createCostmapPalette() {
  let index = 0;
  const palette = new Array(256).fill([0, 0, 0, 0]);
  // zero values have alpha=0
  palette[index++] = [0, 0, 0, 0];

  // Blue to red spectrum for most normal cost values
  for (let i = 1; i <= 98; i++) {
    const v = Math.trunc((255 * i) / 100);
    palette[index++] = [v, 0, 255 - v, 255];
  }
  // inscribed obstacle values (99) in cyan
  palette[index++] = [0, 255, 255, 255];

  // lethal obstacle values (100) in purple
  palette[index++] = [255, 0, 255, 255];

  // illegal positive values in green
  for (let i = 101; i <= 127; i++) {
    palette[index++] = [0, 255, 0, 255];
  }

  // illegal negative (char) values in shades of red/yellow
  for (let i = 128; i <= 254; i++) {
    palette[index++] = [255, Math.trunc((255 * (i - 128)) / (254 - 128)), 0, 255];
  }

  // legal -1 value is tasteful blueish greenish grayish color
  palette[index++] = [112, 137, 134, 255];
  return palette;
}

// Based off of rviz raw implementation
// https://github.com/ros-visualization/rviz/blob/1f622b8c95b8e188841b5505db2f97394d3e9c6c/src/rviz/default_plugin/map_display.cpp#L377
function createRawPalette() {
  let index = 0;
  const palette = new Array(256).fill([0, 0, 0, 0]);

  // Standard gray map palette values
  for (let i = 0; i < 256; i++) {
    palette[index++] = [i, i, i, 255];
  }

  return palette;
}
