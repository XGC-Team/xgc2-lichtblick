// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import type { MessageEvent } from "@lichtblick/suite";
import type {
  IRenderer,
  RendererConfig,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";
import type { NodeError } from "@lichtblick/suite-base/panels/ThreeDeeRender/LayerErrors";
import { Renderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/Renderer";
import { ImageMode } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/ImageMode/ImageMode";
import { Markers } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/Markers";
import { MeasurementTool } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/MeasurementTool";
import { PoseArrays } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PoseArrays";
import { PublishClickTool } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PublishClickTool";
import { resolveLiveTfHistory } from "@lichtblick/suite-base/panels/ThreeDeeRender/transforms/TransformTree";

import { readFramePixels } from "./capture";
import { OFFLINE_TF_HISTORY_SECONDS, validateTransformHistory } from "./history";
import {
  interactivePreviewEnabled,
  requireCapturePixelRatio,
  taintsOnFrameError,
} from "./interactive";
import {
  assetPath,
  nanos,
  record,
  requireValue,
  rosNanos,
  selectFrame,
  verifiedFetch,
  type CameraFrame,
  type FramePlan,
  type Snapshot,
  type SnapshotEvent,
} from "./state";

/** Only used by the separate offline entry. The live ImageMode remains unchanged. */
class OfflineImageMode extends ImageMode {
  public async decodeOriginal(frame: CameraFrame): Promise<void> {
    const renderable = this.imageRenderable;
    const image = renderable?.userData.image;
    requireValue(
      renderable != undefined && image != undefined,
      "Image message did not create a renderable",
    );
    const stamp = "header" in image ? image.header.stamp : image.timestamp;
    requireValue(rosNanos(stamp) === nanos(frame.cameraTimeNs), "Native image timestamp mismatch");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Original image decoding timed out"));
      }, 30000);
      // The native handler may have started a 1920px preview decode. A second,
      // newer submission uses original width; its callback gates this frame.
      renderable.setImage(image, frame.width, () => {
        clearTimeout(timeout);
        const decoded = renderable.getDecodedImage();
        if (decoded?.width !== frame.width || decoded.height !== frame.height) {
          reject(new Error("Original image decode did not preserve native dimensions"));
        } else {
          resolve();
        }
      });
    });
  }
}

function errors(node: NodeError): string[] {
  return [
    ...(node.errorsById?.values() ?? []),
    ...Array.from(node.children?.values() ?? []).flatMap(errors),
  ];
}

/** Native ROS scene semantics, with a persistent read-back surface for capture. */
export class OfflineRenderer {
  readonly #renderer: Renderer;
  readonly #imageMode: OfflineImageMode;
  readonly #interactive: boolean;
  readonly #output: CanvasRenderingContext2D | undefined;
  readonly #scratch: HTMLDivElement | undefined;
  readonly #canvas: HTMLCanvasElement;
  readonly #snapshot: Snapshot;
  readonly #sha256: string;
  readonly #base: URL;
  readonly #data: SnapshotEvent[];
  readonly #tf: SnapshotEvent[];
  readonly #static: SnapshotEvent[];
  #staticCursor = 0;
  #dataCursor = 0;
  #tfCursor = 0;
  #previousTime = -1n;
  #lastImageId: string | undefined;
  #tainted = false;

  public constructor(snapshot: Snapshot, history: SnapshotEvent[], sha256: string, base: URL) {
    requireValue(
      new URLSearchParams(location.search).get("xgcTfHistorySeconds") ===
        String(OFFLINE_TF_HISTORY_SECONDS),
      "Offline TF history query is missing; do not use the two-second live defaults",
    );
    validateTransformHistory(history, resolveLiveTfHistory(location.search));
    const interactive = interactivePreviewEnabled(location.search);
    requireCapturePixelRatio(window.devicePixelRatio, { interactive });
    requireValue(record(snapshot.rendererConfig), "Missing renderer config");
    const config = snapshot.rendererConfig as unknown as RendererConfig;
    requireValue(
      config.imageMode.imageTopic === snapshot.recipe.source.cameraTopic &&
        typeof config.imageMode.calibrationTopic === "string" &&
        config.imageMode.synchronize === false,
      "Invalid offline camera config",
    );
    requireValue(
      Object.keys(config.layers).length === 0 &&
        config.imageMode.rotation === 0 &&
        config.imageMode.flipHorizontal !== true &&
        config.imageMode.flipVertical !== true,
      "Unsupported layout transformation",
    );
    this.#snapshot = snapshot;
    this.#sha256 = sha256;
    this.#base = base;
    this.#interactive = interactive;
    this.#data = history.filter((r) => r.role === "data");
    this.#tf = history.filter((r) => r.role === "tf");
    this.#static = history.filter((r) => r.role === "tf-static");

    const canvas = document.createElement("canvas");
    canvas.width = 3840;
    canvas.height = 2160;
    this.#canvas = canvas;
    if (interactive) {
      // Interactive preview renders straight to the visible WebGL canvas. The
      // native input/resize pipeline owns its drawing-buffer size from here.
      Object.assign(canvas.style, { display: "block", width: "100vw", height: "100vh" });
      document.body.append(canvas);
    } else {
      // Keep the native canvas sized/layout-active, but never expose incomplete draws.
      const scratch = document.createElement("div");
      Object.assign(scratch.style, {
        position: "absolute",
        left: "-10000px",
        top: "0",
        width: "3840px",
        height: "2160px",
      });
      scratch.append(canvas);
      document.body.append(scratch);
      this.#scratch = scratch;
      const display = document.createElement("canvas");
      display.id = "offline-output";
      display.width = 3840;
      display.height = 2160;
      Object.assign(display.style, { display: "block", width: "3840px", height: "2160px" });
      document.body.append(display);
      const output = display.getContext("2d");
      requireValue(output != undefined, "Missing capture canvas context");
      this.#output = output;
    }
    let imageMode: OfflineImageMode | undefined;
    this.#renderer = new Renderer({
      canvas,
      config,
      interfaceMode: "image",
      customCameraModels: new Map(),
      testOptions: {},
      fetchAsset: async () => {
        throw new Error("External/URDF/mesh assets are forbidden by offline V1");
      },
      sceneExtensionConfig: {
        reserved: {
          measurementTool: { init: (renderer: IRenderer) => new MeasurementTool(renderer) },
          publishClickTool: { init: (renderer: IRenderer) => new PublishClickTool(renderer) },
          imageMode: {
            init: (renderer: IRenderer) => {
              imageMode = new OfflineImageMode(renderer);
              return imageMode;
            },
          },
        },
        extensionsById: {
          [Markers.extensionId]: { init: (renderer: IRenderer) => new Markers(renderer) },
          [PoseArrays.extensionId]: { init: (renderer: IRenderer) => new PoseArrays(renderer) },
        },
      },
    });
    requireValue(imageMode != undefined, "Native ImageMode was not initialized");
    this.#imageMode = imageMode;
    this.#renderer.ros = true;
    if (!interactive) {
      // This instance has no live data player, publish tool listener or scene editor.
      this.#renderer.queueAnimationFrame = () => undefined;
    }
    this.#renderer.setTopics(snapshot.topics);
    this.#renderer.setPickingEnabled(false);
    this.#renderer.setColorScheme("light", undefined);
  }

  #dispatch(row: SnapshotEvent): void {
    const renderer = this.#renderer;
    renderer.setCurrentTime(nanos(row.timeNs));
    const event: MessageEvent = row.event;
    // Keep native coordinate-frame discovery, but bypass ONLY live queue coalescing.
    renderer.addMessageEvent(event, { inBatch: true });
    const subscriptions = new Set([
      ...(renderer.topicSubscriptions.get(event.topic) ?? []),
      ...(renderer.schemaSubscriptions.get(event.schemaName) ?? []),
    ]);
    requireValue(subscriptions.size > 0, `No native renderer handles ${event.schemaName}`);
    for (const subscription of subscriptions) {
      if (subscription.shouldSubscribe?.(event.topic) !== false) {
        subscription.handler(event);
      }
    }
  }

  public async frame(plan: FramePlan): Promise<FramePlan> {
    requireValue(!this.#tainted, "Recreate failed offline renderer before retry");
    try {
      const image = selectFrame(this.#snapshot, plan, this.#sha256);
      const time = nanos(image.cameraTimeNs);
      if (time < this.#previousTime) {
        this.#renderer.clear({ clearTransforms: true, resetAllFramesCursor: true });
        this.#dataCursor = 0;
        this.#tfCursor = 0;
        this.#staticCursor = 0;
        this.#lastImageId = undefined;
      }
      // Static messages are indexed by their availability; dynamic TF permits an
      // explicit bounded lookahead for interpolation, never for algorithm data.
      while (this.#staticCursor < this.#static.length) {
        const row = this.#static[this.#staticCursor]!;
        if (nanos(row.timeNs) > nanos(image.logTimeNs)) {
          break;
        }
        this.#dispatch(row);
        this.#staticCursor++;
      }
      const tfEnd = time + nanos(this.#snapshot.policy.tfLookaheadNs);
      while (this.#tfCursor < this.#tf.length) {
        const row = this.#tf[this.#tfCursor]!;
        if (nanos(row.timeNs) > tfEnd) {
          break;
        }
        this.#dispatch(row);
        this.#tfCursor++;
      }
      while (this.#dataCursor < this.#data.length) {
        const row = this.#data[this.#dataCursor]!;
        if (nanos(row.timeNs) > time) {
          break;
        }
        this.#dispatch(row);
        this.#dataCursor++;
      }
      this.#renderer.setCurrentTime(time);
      if (this.#lastImageId !== image.sourceFrameId) {
        const bytes = await verifiedFetch(
          new URL(assetPath(image.asset), this.#base),
          image.asset.sha256,
          image.asset.size,
        );
        requireValue(bytes.byteLength === image.asset.size, "Camera asset size mismatch");
        this.#dispatch({
          timeNs: image.cameraTimeNs,
          role: "data",
          event: {
            topic: this.#snapshot.recipe.source.cameraTopic,
            schemaName: "sensor_msgs/CompressedImage",
            receiveTime: image.header.stamp,
            sizeInBytes: bytes.byteLength,
            message: { header: image.header, format: image.format, data: new Uint8Array(bytes) },
          },
        });
        await this.#imageMode.decodeOriginal(image);
      }
      await this.#renderer.settleVideoDecodes();
      await document.fonts.ready;
      this.#renderer.setCurrentTime(time);
      this.#renderer.animationFrame();
      const found = errors(this.#renderer.settings.errors.errors);
      requireValue(found.length === 0, found.slice(0, 8).join("; "));
      let width = image.width;
      let height = image.height;
      if (this.#output != undefined) {
        // Strict capture only: interactive frames stay on the GPU canvas and
        // never pay the 4K readback/2D copy.
        const gl = this.#renderer.gl.getContext();
        requireValue(gl instanceof WebGL2RenderingContext, "WebGL2 required");
        const pixels = readFramePixels(gl, image.width, image.height);
        const capture = new ImageData(image.width, image.height);
        capture.data.set(pixels);
        this.#output.putImageData(capture, 0, 0);
        width = this.#output.canvas.width;
        height = this.#output.canvas.height;
      }
      this.#previousTime = time;
      this.#lastImageId = image.sourceFrameId;
      return {
        ...plan,
        sourceFrameId: image.sourceFrameId,
        cameraTimeNs: image.cameraTimeNs,
        width,
        height,
      };
    } catch (error) {
      // Strict capture taints on any failure. An interactive scrub frame may
      // fail without tainting; the host can retry it or drop it.
      if (taintsOnFrameError({ interactive: this.#interactive })) {
        this.#tainted = true;
      }
      throw error;
    }
  }

  public dispose(): void {
    this.#tainted = true;
    this.#renderer.dispose();
    this.#scratch?.remove();
    this.#output?.canvas.remove();
    this.#canvas.remove();
  }
}
