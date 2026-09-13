// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { canonicalVideoCodec } from "@lichtblick/den/video";
import { toNanoSec } from "@lichtblick/rostime";

import { IRenderer } from "../IRenderer";
import { SceneExtensionConfig, DEFAULT_SCENE_EXTENSION_CONFIG } from "../SceneExtensionConfig";
import { ImageMode } from "../renderables/ImageMode/ImageMode";
import { ImageRenderable, ImageUserData } from "../renderables/Images/ImageRenderable";
import { AnyImage } from "../renderables/Images/ImageTypes";
import { NativeImageDecodeGate, NativeImageReceipt } from "./NativeImageDecodeGate";

/**
 * Offline-only renderable. Existing live ImageMode keeps its 1920 decode-width policy.
 * The preparer must provide independently decodable source frames (raw or JPEG/PNG), with
 * verified original timestamps. Inter-frame video must be decoded by the preparation adapter;
 * the live video decoder may intentionally reuse a previous bitmap on recoverable errors.
 */
export class NativeExportImageRenderable extends ImageRenderable {
  readonly #gate = new NativeImageDecodeGate();
  readonly #epochs = new WeakMap<object, number>();

  public override setImage(image: AnyImage, _resizeWidth?: number, onDecoded?: () => void): void {
    if (this.isDisposed()) {
      return;
    }
    const imageTimeNs = toNanoSec("header" in image ? image.header.stamp : image.timestamp);
    const epoch = this.#gate.begin(imageTimeNs);
    this.#epochs.set(image, epoch);
    if ("format" in image && canonicalVideoCodec(image.format) != undefined) {
      this.#gate.fail(epoch, new Error("Prepare an independently decoded frame before native offline export"));
      return;
    }
    // undefined is the existing decoder's native-resolution option; no change to live policy.
    super.setImage(image, undefined, () => {
      const decoded = this.getDecodedImage();
      if (decoded) {
        this.#gate.complete(epoch, { imageTimeNs, width: decoded.width, height: decoded.height });
      } else {
        this.#gate.fail(epoch, new Error("Decoder completed without an image"));
      }
      onDecoded?.();
    });
  }

  protected override async decodeImage(image: AnyImage, _resizeWidth?: number): Promise<ImageBitmap | ImageData> {
    const epoch = this.#epochs.get(image);
    try {
      return await super.decodeImage(image, undefined);
    } catch (error) {
      if (epoch != undefined) {
        // The base class also calls onDecoded for its error bitmap. Reject before that callback.
        this.#gate.fail(epoch, error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  public waitForNativeImage(imageTimeNs: bigint, signal?: AbortSignal): Promise<NativeImageReceipt> {
    return this.#gate.wait(imageTimeNs, signal);
  }

  public override resetVideoForSeek(): void {
    this.#gate.invalidate("Offline image was reset for seek");
    super.resetVideoForSeek();
  }

  public override dispose(): void {
    this.#gate.dispose();
    super.dispose();
  }
}

export class NativeExportImageMode extends ImageMode {
  protected override initRenderable(topicName: string, userData: ImageUserData): ImageRenderable {
    return new NativeExportImageRenderable(topicName, this.renderer, userData);
  }

  public waitForNativeImage(imageTimeNs: bigint, signal?: AbortSignal): Promise<NativeImageReceipt> {
    if (!(this.imageRenderable instanceof NativeExportImageRenderable)) {
      return Promise.reject(new Error("No native export image has been submitted"));
    }
    return this.imageRenderable.waitForNativeImage(imageTimeNs, signal);
  }
}

/** Opt in only when constructing a dedicated offline renderer. Never mutate the live defaults. */
export function nativeExportSceneExtensions(
  base: SceneExtensionConfig = DEFAULT_SCENE_EXTENSION_CONFIG,
): SceneExtensionConfig {
  return {
    ...base,
    reserved: {
      ...base.reserved,
      imageMode: {
        ...base.reserved.imageMode,
        init: (renderer: IRenderer) => new NativeExportImageMode(renderer),
      },
    },
    extensionsById: { ...base.extensionsById },
  };
}
