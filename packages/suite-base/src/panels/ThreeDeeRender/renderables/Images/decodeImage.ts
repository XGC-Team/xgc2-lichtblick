// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { RawImage } from "@foxglove/schemas";
import * as _ from "lodash-es";

import {
  decodeBGR8,
  decodeBGRA8,
  decodeBayerBGGR8,
  decodeBayerGBRG8,
  decodeBayerGRBG8,
  decodeBayerRGGB8,
  decodeFloat1c,
  decodeMono16,
  decodeMono8,
  decodeRGB8,
  decodeRGBA8,
  decodeUYVY,
  decodeYUYV,
} from "@lichtblick/den/image";
import {
  H264 as H264Parser,
  H265 as H265Parser,
  VideoCodec,
  VideoPlayer,
  canonicalVideoCodec,
  isVideoKeyframe,
} from "@lichtblick/den/video";
import { toNanoSec } from "@lichtblick/rostime";

import { CompressedImageTypes, CompressedVideo } from "./ImageTypes";
import { PreparedVideoFrame, PreparedVideoFrameStatus, PrepareVideoFrameContext } from "./types";
import { Image as RosImage } from "../../ros";
import { ColorModeSettings, getColorConverter } from "../colorMode";

// Codec normalization (`VideoCodec`, `canonicalVideoCodec`, `isVideoKeyframe`) lives in
// `@lichtblick/den/video` so both the renderer and the player-side seek backfill share a single
// source of truth.

const JPEG_BLOB_SUBTYPES = new Set(["jpeg", "jpg", "jpe", "mjpeg"]);

export function isJpegBytes(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
}

function isPngBytes(data: Uint8Array): boolean {
  return (
    data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  );
}

async function readBlobPrefix(blob: Blob, n: number): Promise<Uint8Array> {
  const slice = blob.slice(0, n);
  if (typeof slice.arrayBuffer === "function") {
    try {
      return new Uint8Array(await slice.arrayBuffer());
    } catch {
      // jsdom Blob#slice may not implement arrayBuffer().
    }
  }
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("blob read failed"));
    };
    reader.readAsArrayBuffer(slice);
  });
}

async function blobLooksLikeRaster(blob: Blob): Promise<boolean> {
  const type = blob.type.toLowerCase();
  if (
    type === "image/jpeg" ||
    type === "image/jpg" ||
    type === "image/png" ||
    type === "image/webp"
  ) {
    return true;
  }
  const header = await readBlobPrefix(blob, 4);
  return isJpegBytes(header) || isPngBytes(header);
}

/**
 * ROS `format` is often `jpg` / `mjpeg` / `jpeg; jpeg compressed rgb8` /
 * `bgr8; jpeg compressed bgr8`. Safari rejects those MIME types; Chrome sniffs.
 */
export function compressedImageBlobType(format: string, data?: Uint8Array): string {
  const raw = format.trim().toLowerCase();
  const subtype = raw.split(";", 1)[0]!.trim();
  if (
    JPEG_BLOB_SUBTYPES.has(subtype) ||
    subtype === "image/jpeg" ||
    subtype === "image/jpg" ||
    /\bjpe?g\b/.test(raw) ||
    (data != undefined && isJpegBytes(data))
  ) {
    return "image/jpeg";
  }
  if (subtype === "png" || subtype === "image/png") {
    return "image/png";
  }
  if (subtype === "webp" || subtype === "image/webp") {
    return "image/webp";
  }
  if (subtype.startsWith("image/")) {
    return subtype;
  }
  return `image/${subtype || "octet-stream"}`;
}

function revokeObjectUrl(url: string): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function" && url) {
    URL.revokeObjectURL(url);
  }
}

/** iPhone / iPad / mobile WebKit: Blob JPEG `createImageBitmap` often throws or poisons the GPU. */
export function preferHtmlRasterDecode(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  const touchPoints = Number(navigator.maxTouchPoints);
  const iOSDevice =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && Number.isFinite(touchPoints) && touchPoints > 1);
  const mobileWebKit = ua.includes("AppleWebKit") && ua.includes("Mobile");
  return iOSDevice || mobileWebKit;
}

function closeBitmap(bitmap: ImageBitmap): void {
  if (typeof bitmap.close === "function") {
    bitmap.close();
  }
}

type TwoDContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function acquire2dContext(
  width: number,
  height: number,
): { canvas: CanvasImageSource; context: TwoDContext } | undefined {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (context) {
      return { canvas, context };
    }
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
      return { canvas, context };
    }
  }
  return undefined;
}

async function rasterToBitmap(
  width: number,
  height: number,
  paint: (context: TwoDContext) => void,
): Promise<ImageBitmap> {
  const acquired = acquire2dContext(width, height);
  if (!acquired) {
    throw new Error(`Unable to rasterize image to ${width}x${height}`);
  }
  paint(acquired.context);
  try {
    const imageData = acquired.context.getImageData(0, 0, width, height);
    return await createImageBitmap(imageData);
  } catch {
    return await createImageBitmap(acquired.canvas);
  }
}

function scaledSize(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number | undefined,
): { width: number; height: number } {
  if (targetWidth == undefined || !(sourceWidth > targetWidth)) {
    return { width: sourceWidth, height: sourceHeight };
  }
  return {
    width: targetWidth,
    height: Math.max(1, Math.round((sourceHeight * targetWidth) / sourceWidth)),
  };
}

async function loadHtmlImage(blob: Blob): Promise<HTMLImageElement> {
  if (typeof Image !== "function") {
    throw new Error("HTML Image is not available");
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => {
        reject(new Error("HTML image failed to decode"));
      };
      image.onload = () => {
        resolve();
      };
      image.onerror = fail;
      image.src = url;
    });
    return image;
  } catch (error) {
    revokeObjectUrl(url);
    throw error;
  }
}

/**
 * Phone WebKit can decode JPEG via HTML Image even when Blob `createImageBitmap`
 * throws. Return ImageData for THREE.DataTexture — do not wrap it in
 * `createImageBitmap`, which is the remaining red-X failure on iOS.
 */
async function imageDataFromHtmlImage(
  blob: Blob,
  targetWidth: number | undefined,
): Promise<ImageData> {
  const image = await loadHtmlImage(blob);
  try {
    const sourceWidth = image.naturalWidth > 0 ? image.naturalWidth : image.width;
    const sourceHeight = image.naturalHeight > 0 ? image.naturalHeight : image.height;
    if (!(sourceWidth > 0 && sourceHeight > 0)) {
      throw new Error("Decoded image has no dimensions");
    }
    const size = scaledSize(sourceWidth, sourceHeight, targetWidth);
    if (typeof document === "undefined") {
      throw new Error("document canvas is not available");
    }
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error(`Unable to rasterize image to ${size.width}x${size.height}`);
    }
    context.drawImage(image, 0, 0, size.width, size.height);
    return context.getImageData(0, 0, size.width, size.height);
  } finally {
    revokeObjectUrl(image.src);
  }
}

async function downscaleBitmap(bitmap: ImageBitmap, targetWidth: number): Promise<ImageBitmap> {
  const height = Math.max(1, Math.round((bitmap.height * targetWidth) / bitmap.width));
  try {
    const reduced = await createImageBitmap(bitmap, { resizeWidth: targetWidth });
    if (reduced.width > 0 && !(reduced.width > targetWidth)) {
      if (reduced !== bitmap) {
        closeBitmap(bitmap);
      }
      return reduced;
    }
    if (reduced !== bitmap) {
      closeBitmap(reduced);
    }
  } catch {
    // Canvas / ImageData downscale below.
  }

  try {
    const reduced = await rasterToBitmap(targetWidth, height, (context) => {
      context.drawImage(bitmap, 0, 0, targetWidth, height);
    });
    closeBitmap(bitmap);
    return reduced;
  } catch (error) {
    closeBitmap(bitmap);
    throw error;
  }
}

/**
 * Phone WebKit often throws on Blob JPEG `createImageBitmap`, or on
 * `resizeWidth`, or ignores it and returns a 4K bitmap that then fails WebGL
 * (`MAX_TEXTURE_SIZE` 2048). Desktop Chrome is fine. Compressed JPEG fallback
 * lives in {@link decodeCompressedImageToBitmap} (HTML Image → ImageData), not
 * here — wrapping ImageData in `createImageBitmap` still red-Xes on iOS.
 */
export async function createImageBitmapMaybeResized(
  source: ImageBitmapSource,
  resizeWidth?: number,
): Promise<ImageBitmap> {
  const wantsResize = resizeWidth != undefined && Number.isFinite(resizeWidth) && resizeWidth > 0;
  const targetWidth = wantsResize ? Math.floor(resizeWidth) : undefined;

  if (source instanceof Blob) {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap =
        targetWidth != undefined
          ? await createImageBitmap(source, { resizeWidth: targetWidth })
          : await createImageBitmap(source);
      if (targetWidth == undefined || !(bitmap.width > targetWidth)) {
        return bitmap;
      }
    } catch {
      bitmap = undefined;
    }

    bitmap ??= await createImageBitmap(source);
    if (targetWidth == undefined || !(bitmap.width > targetWidth)) {
      return bitmap;
    }
    return await downscaleBitmap(bitmap, targetWidth);
  }

  let bitmap: ImageBitmap | undefined;
  if (targetWidth == undefined) {
    bitmap = await createImageBitmap(source);
  } else {
    try {
      bitmap = await createImageBitmap(source, { resizeWidth: targetWidth });
    } catch {
      bitmap = undefined;
    }
    bitmap ??= await createImageBitmap(source);
  }

  if (targetWidth == undefined || !(bitmap.width > targetWidth)) {
    return bitmap;
  }
  return await downscaleBitmap(bitmap, targetWidth);
}

export async function decodeCompressedImageToBitmap(
  image: CompressedImageTypes,
  resizeWidth?: number,
): Promise<ImageBitmap | ImageData> {
  const data = new Uint8Array(image.data);
  const bitmapData = new Blob([data], {
    type: compressedImageBlobType(image.format, data),
  });
  const looksRaster = await blobLooksLikeRaster(bitmapData);
  if (looksRaster && preferHtmlRasterDecode()) {
    return await imageDataFromHtmlImage(bitmapData, resizeWidth);
  }
  try {
    return await createImageBitmapMaybeResized(bitmapData, resizeWidth);
  } catch (error) {
    if (looksRaster) {
      return await imageDataFromHtmlImage(bitmapData, resizeWidth);
    }
    throw error;
  }
}

export function isCompressedVideoKeyframe(
  frameMsg: CompressedVideo,
  resolvedCodec?: VideoCodec,
): boolean {
  return isVideoKeyframe(frameMsg.format, frameMsg.data, resolvedCodec);
}

export function getVideoDecoderConfig(frameMsg: CompressedVideo): VideoDecoderConfig | undefined {
  switch (canonicalVideoCodec(frameMsg.format)) {
    // Search for an SPS NAL unit to initialize the decoder. This should precede each keyframe.
    case VideoCodec.H264:
      return H264Parser.ParseDecoderConfig(frameMsg.data);
    case VideoCodec.H265:
      return H265Parser.ParseDecoderConfig(frameMsg.data);
  }
  return undefined;
}

export function prepareVideoFrame(
  frameMsg: CompressedVideo,
  context?: PrepareVideoFrameContext,
  resolvedCodec?: VideoCodec,
): PreparedVideoFrame {
  switch (resolvedCodec ?? canonicalVideoCodec(frameMsg.format)) {
    case VideoCodec.H265: {
      const frameInfo = H265Parser.InspectFrame(frameMsg.data, context?.h265);
      if (frameInfo.bitstreamFormat === "unknown" || frameInfo.normalizedData == undefined) {
        return {
          data: frameMsg.data,
          status: PreparedVideoFrameStatus.UnsupportedBitstream,
          diagnostics: "unsupported H.265 bitstream format",
          type: "delta",
        };
      }
      if (frameInfo.frameType === "B") {
        return {
          data: frameInfo.normalizedData,
          status: PreparedVideoFrameStatus.UnsupportedBFrame,
          diagnostics: "H.265 B frames are not supported",
          type: "delta",
        };
      }

      const type = frameInfo.isKeyframe ? "key" : "delta";
      return {
        data:
          type === "key"
            ? frameInfo.normalizedData
            : (frameInfo.strippedData ?? frameInfo.normalizedData),
        decoderConfig: H265Parser.ParseDecoderConfig(frameInfo.normalizedData),
        status: PreparedVideoFrameStatus.Ok,
        type,
      };
    }
    case VideoCodec.H264:
    default: {
      const frameData = frameMsg.data;
      const type = H264Parser.IsKeyframe(frameData) ? "key" : "delta";
      return {
        data: frameData,
        // Only keyframes carry an SPS; delta frames have nothing to parse.
        decoderConfig: type === "key" ? H264Parser.ParseDecoderConfig(frameData) : undefined,
        status: PreparedVideoFrameStatus.Ok,
        type,
      };
    }
  }
}

export async function decodeCompressedVideoToBitmap(
  frameMsg: Pick<CompressedVideo, "timestamp">,
  preparedFrame: PreparedVideoFrame,
  videoPlayer: VideoPlayer,
  firstMessageTime: bigint,
  resizeWidth?: number,
  options?: { retainPreviousBitmap?: boolean },
): Promise<ImageBitmap> {
  if (!videoPlayer.isInitialized()) {
    return await emptyVideoFrame(videoPlayer, resizeWidth);
  }

  // Match Foxglove/WebCodecs behavior by using integer microseconds relative to the first frame.
  const timestampMicros = Number((toNanoSec(frameMsg.timestamp) - firstMessageTime) / 1000n);

  const videoFrame = await videoPlayer.decode(
    preparedFrame.data,
    timestampMicros,
    preparedFrame.type,
  );
  try {
    const frameToRender = videoFrame ?? videoPlayer.lastVideoFrame;
    if (!frameToRender) {
      return videoPlayer.lastImageBitmap ?? (await emptyVideoFrame(videoPlayer, resizeWidth));
    }
    // Skip re-encoding the same frame when the decoder produced nothing new.
    if (!videoFrame && videoPlayer.lastImageBitmap) {
      return videoPlayer.lastImageBitmap;
    }
    const imageBitmap = await createImageBitmapMaybeResized(frameToRender, resizeWidth);
    // A renderable may still own the previous bitmap as its current texture.
    // Closing it here detaches its dimensions and can force texture reallocation
    // or invalidate an upload before the replacement is ready to be presented.
    if (options?.retainPreviousBitmap !== true) {
      videoPlayer.lastImageBitmap?.close();
    }
    videoPlayer.lastImageBitmap = imageBitmap;
    return imageBitmap;
  } finally {
    videoFrame?.close();
  }
}

export const IMAGE_DEFAULT_COLOR_MODE_SETTINGS: Required<
  Omit<ColorModeSettings, "colorField" | "minValue" | "maxValue">
> = {
  colorMode: "gradient",
  flatColor: "#ffffff",
  gradient: ["#000000", "#ffffff"],
  colorMap: "turbo",
  explicitAlpha: 0,
};
const MIN_MAX_16_BIT = { minValue: 0, maxValue: 65535 };

export type RawImageOptions = ColorModeSettings;

/**
 * See also:
 * https://github.com/ros2/common_interfaces/blob/366eea24ffce6c87f8860cbcd27f4863f46ad822/sensor_msgs/include/sensor_msgs/image_encodings.hpp
 */
export function decodeRawImage(
  image: RosImage | RawImage,
  options: Partial<RawImageOptions>,
  output: Uint8ClampedArray,
): void {
  const { encoding, width, height, step } = image;
  const is_bigendian = "is_bigendian" in image ? image.is_bigendian : false;
  const rawData = image.data as Uint8Array;
  switch (encoding) {
    case "yuv422":
    case "uyvy":
      decodeUYVY(rawData, width, height, step, output);
      break;
    case "yuv422_yuy2":
    case "yuyv":
      decodeYUYV(rawData, width, height, step, output);
      break;
    case "rgb8":
      decodeRGB8(rawData, width, height, step, output);
      break;
    case "rgba8":
      decodeRGBA8(rawData, width, height, step, output);
      break;
    case "bgra8":
      decodeBGRA8(rawData, width, height, step, output);
      break;
    case "bgr8":
    case "8UC3":
      decodeBGR8(rawData, width, height, step, output);
      break;
    case "32FC1":
      decodeFloat1c(rawData, width, height, step, is_bigendian, output);
      break;
    case "bayer_rggb8":
      decodeBayerRGGB8(rawData, width, height, step, output);
      break;
    case "bayer_bggr8":
      decodeBayerBGGR8(rawData, width, height, step, output);
      break;
    case "bayer_gbrg8":
      decodeBayerGBRG8(rawData, width, height, step, output);
      break;
    case "bayer_grbg8":
      decodeBayerGRBG8(rawData, width, height, step, output);
      break;
    case "mono8":
    case "8UC1":
      decodeMono8(rawData, width, height, step, output);
      break;
    case "mono16":
    case "16UC1": {
      // combine options with defaults. lodash merge makes sure undefined values in options are replaced with defaults
      // whereas a normal spread would allow undefined values to overwrite defaults
      const settings = _.merge({}, IMAGE_DEFAULT_COLOR_MODE_SETTINGS, MIN_MAX_16_BIT, options);
      if (settings.colorMode === "rgba-fields" || settings.colorMode === "flat") {
        throw Error(`${settings.colorMode} color mode is not supported for mono16 images`);
      }
      const min = settings.minValue;
      const max = settings.maxValue;
      const tempColor = { r: 0, g: 0, b: 0, a: 0 };
      const converter = getColorConverter(
        settings as ColorModeSettings & {
          colorMode: typeof settings.colorMode;
        },
        min,
        max,
      );
      decodeMono16(rawData, width, height, step, is_bigendian, output, {
        minValue: options.minValue,
        maxValue: options.maxValue,
        colorConverter: (value: number) => {
          converter(tempColor, value);
          return tempColor;
        },
      });
      break;
    }
    default:
      throw new Error(`Unsupported encoding ${encoding}`);
  }
}

// Performance sensitive, skip the extra await when returning a blank image
// eslint-disable-next-line @typescript-eslint/promise-function-async
export function emptyVideoFrame(
  videoPlayer?: VideoPlayer,
  resizeWidth?: number,
): Promise<ImageBitmap> {
  const width = resizeWidth ?? 32;
  const size = videoPlayer?.codedSize() ?? { width, height: width };
  const data = new ImageData(size.width, size.height);
  return createImageBitmapMaybeResized(data, size.width);
}
