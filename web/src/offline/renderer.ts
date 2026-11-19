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
import { ObstacleSceneExtension } from "@lichtblick/suite-base/panels/ThreeDeeRender/ObstacleScene/ObstacleSceneExtension";
import { parseSceneEnvelope } from "@lichtblick/suite-base/panels/ThreeDeeRender/ObstacleScene/types";
import { Renderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/Renderer";
import { ImageMode } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/ImageMode/ImageMode";
import { presentableImageSize } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/Images/VideoFrameTexture";
import { Markers } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/Markers";
import { MeasurementTool } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/MeasurementTool";
import { PoseArrays } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PoseArrays";
import { PublishClickTool } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PublishClickTool";
import { SceneSettings } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/SceneSettings";
import {
  Urdfs,
  type LayerSettingsCustomUrdf,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/Urdfs";
import { resolveLiveTfHistory } from "@lichtblick/suite-base/panels/ThreeDeeRender/transforms/TransformTree";

import { readFramePixels } from "./capture";
import { OfflineEdits, type NativeScene } from "./edits";
import { OFFLINE_TF_HISTORY_SECONDS, validateTransformHistory } from "./history";
import {
  interactivePreviewEnabled,
  requireCapturePixelRatio,
  taintsOnFrameError,
} from "./interactive";
import { activeTrack, trackOpacity, type Track } from "./scene";
import {
  assetPath,
  fetchFrozenModelAsset,
  nanos,
  record,
  requireValue,
  rosNanos,
  selectFrame,
  selectFrame3d,
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
    requireValue(
      rosNanos(stamp) === nanos(frame.renderTimeNs ?? frame.cameraTimeNs),
      "Native image timestamp mismatch",
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Original image decoding timed out"));
      }, 30000);
      // The native handler may have started a 1920px preview decode. A second,
      // newer submission uses original width; its callback gates this frame.
      renderable.setImage(image, frame.width, () => {
        clearTimeout(timeout);
        const decoded = renderable.getDecodedImage();
        const size = decoded == undefined ? undefined : presentableImageSize(decoded);
        if (size?.width !== frame.width || size.height !== frame.height) {
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
  readonly #imageMode: OfflineImageMode | undefined;
  readonly #mode: "image" | "3d";
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
  // Row times are validated and parsed once; every output frame compares and dispatches them.
  readonly #dataTimes: bigint[];
  readonly #tfTimes: bigint[];
  readonly #staticTimes: bigint[];
  // Readback and output storage shared by every strictly captured frame (33 MB each at 4K).
  #readback: Uint8Array | undefined;
  #capture: ImageData | undefined;
  #staticCursor = 0;
  #dataCursor = 0;
  #tfCursor = 0;
  #previousTime = -1n;
  #lastImageId: string | undefined;
  #tainted = false;
  readonly #native: NativeScene = {};
  #edits: OfflineEdits | undefined;
  readonly #paths = new Map<string, { row: SnapshotEvent; timeNs: bigint }>();

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
    const mode = snapshot.recipe.mode ?? "image";
    this.#mode = mode;
    const obstacleScene = config.scene?.obstacleScene;
    if (obstacleScene != undefined) {
      const topic = `${obstacleScene.namespace}/document`;
      const documents = history.filter((row) => row.role === "data" && row.event.topic === topic);
      const message = documents[0]?.event.message;
      requireValue(
        obstacleScene.namespace === "/xgc_media_scene" &&
          documents.length === 1 &&
          documents[0]?.event.schemaName === "std_msgs/String" &&
          record(message) && typeof message.data === "string",
        "Offline obstacle scene requires one frozen compiled document",
      );
      const envelope = parseSceneEnvelope(JSON.parse(message.data));
      requireValue(
        envelope.compiled != undefined && !envelope.playing && !envelope.dirty,
        "Offline obstacle scene must be frozen and compiled",
      );
    }
    if (mode === "image") {
      requireValue(
        record(config.imageMode) &&
          config.imageMode.imageTopic === snapshot.recipe.source?.cameraTopic &&
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
    } else {
      requireValue(
        typeof config.followTf === "string" &&
          config.followTf.length > 0 &&
          record(config.cameraState) &&
          Object.keys(config.layers).length === 0,
        "Invalid offline 3d camera config",
      );
    }
    this.#snapshot = snapshot;
    this.#sha256 = sha256;
    this.#base = base;
    this.#interactive = interactive;
    this.#data = history.filter((r) => r.role === "data");
    this.#tf = history.filter((r) => r.role === "tf");
    this.#static = history.filter((r) => r.role === "tf-static");
    this.#dataTimes = this.#data.map((row) => nanos(row.timeNs));
    this.#tfTimes = this.#tf.map((row) => nanos(row.timeNs));
    this.#staticTimes = this.#static.map((row) => nanos(row.timeNs));

    const outWidth = snapshot.recipe.output.width;
    const outHeight = snapshot.recipe.output.height;
    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;
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
        width: `${outWidth}px`,
        height: `${outHeight}px`,
      });
      scratch.append(canvas);
      document.body.append(scratch);
      this.#scratch = scratch;
      const display = document.createElement("canvas");
      display.id = "offline-output";
      display.width = outWidth;
      display.height = outHeight;
      Object.assign(display.style, {
        display: "block",
        width: `${outWidth}px`,
        height: `${outHeight}px`,
      });
      document.body.append(display);
      const output = display.getContext("2d");
      requireValue(output != undefined, "Missing capture canvas context");
      this.#output = output;
    }
    for (const model of snapshot.models ?? []) {
      requireValue(
        snapshot.tracks?.some(
          (track) => track.kind === "robot-model" && track.id === model.trackId,
        ) === true,
        "Unbound frozen robot model",
      );
      const layer: LayerSettingsCustomUrdf = {
        layerId: "foxglove.Urdf",
        instanceId: model.trackId,
        label: model.trackId,
        visible: true,
        frameLocked: true,
        sourceType: "url",
        url: `https://xgc2.invalid/${model.asset.sha256}.urdf`,
        framePrefix: model.framePrefix,
        displayMode: "visual",
      };
      config.layers[model.trackId] = layer;
    }
    let imageMode: OfflineImageMode | undefined;
    this.#renderer = new Renderer({
      canvas,
      config,
      interfaceMode: mode,
      customCameraModels: new Map(),
      testOptions: {},
      fetchAsset: async (url) => await fetchFrozenModelAsset(snapshot.models ?? [], base, url),
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
          ...(mode === "3d" && {
            [SceneSettings.extensionId]: {
              init: (renderer: IRenderer) => new SceneSettings(renderer),
            },
          }),
          ...(obstacleScene != undefined && {
            [ObstacleSceneExtension.extensionId]: {
              init: (renderer: IRenderer) => new ObstacleSceneExtension(renderer),
            },
          }),
          [Markers.extensionId]: {
            init: (renderer: IRenderer) => (this.#native.markers = new Markers(renderer)),
          },
          [PoseArrays.extensionId]: {
            init: (renderer: IRenderer) => (this.#native.paths = new PoseArrays(renderer)),
          },
          [Urdfs.extensionId]: {
            init: (renderer: IRenderer) => (this.#native.urdfs = new Urdfs(renderer)),
          },
          "xgc2.OfflineEdits": {
            init: (renderer: IRenderer) =>
              (this.#edits = new OfflineEdits(renderer, snapshot.tracks ?? [], this.#native)),
          },
        },
      },
    });
    if (mode === "image") {
      requireValue(imageMode != undefined, "Native ImageMode was not initialized");
    }
    this.#imageMode = imageMode;
    this.#renderer.ros = true;
    if (!interactive) {
      // This instance has no live data player, publish tool listener or scene editor.
      this.#renderer.queueAnimationFrame = () => undefined;
    }
    this.#renderer.setTopics(snapshot.topics);
    this.#renderer.setPickingEnabled(false);
    this.#renderer.setColorScheme(
      "light",
      mode === "3d" ? config.scene?.backgroundColor : undefined,
    );
  }

  #dispatch(row: SnapshotEvent, timeNs: bigint): void {
    const renderer = this.#renderer;
    if (row.event.schemaName === "nav_msgs/Path") {
      this.#paths.set(row.event.topic, { row, timeNs });
    }
    renderer.setCurrentTime(timeNs);
    const event: MessageEvent = row.event;
    // Keep native coordinate-frame discovery, but bypass ONLY live queue coalescing.
    renderer.addMessageCoordinateFrames(event.message);
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
      const image =
        this.#mode === "image" ? selectFrame(this.#snapshot, plan, this.#sha256) : undefined;
      const time =
        image != undefined
          ? nanos(image.renderTimeNs ?? image.cameraTimeNs)
          : selectFrame3d(this.#snapshot, plan, this.#sha256);
      const editTime = nanos(plan.targetTimeNs);
      if (this.#edits != undefined) {
        this.#edits.time = editTime;
      }
      if (this.#mode === "3d" && record(plan.cameraState)) {
        this.#renderer.setCameraState({
          ...this.#renderer.config.cameraState,
          ...plan.cameraState,
        });
      }
      if (time < this.#previousTime) {
        this.#renderer.clear({ clearTransforms: true, resetAllFramesCursor: true });
        this.#dataCursor = 0;
        this.#tfCursor = 0;
        this.#staticCursor = 0;
        this.#lastImageId = undefined;
        this.#paths.clear();
      }
      // Static messages are indexed by their availability; dynamic TF permits an
      // explicit bounded lookahead for interpolation, never for algorithm data.
      const logTime = image != undefined ? nanos(image.logTimeNs) : time;
      while (this.#staticCursor < this.#static.length) {
        const rowTime = this.#staticTimes[this.#staticCursor]!;
        if (rowTime > logTime) {
          break;
        }
        this.#dispatch(this.#static[this.#staticCursor]!, rowTime);
        this.#staticCursor++;
      }
      const tfEnd = time + nanos(this.#snapshot.policy.tfLookaheadNs);
      while (this.#tfCursor < this.#tf.length) {
        const rowTime = this.#tfTimes[this.#tfCursor]!;
        if (rowTime > tfEnd) {
          break;
        }
        this.#dispatch(this.#tf[this.#tfCursor]!, rowTime);
        this.#tfCursor++;
      }
      while (this.#dataCursor < this.#data.length) {
        const rowTime = this.#dataTimes[this.#dataCursor]!;
        if (rowTime > time) {
          break;
        }
        this.#dispatch(this.#data[this.#dataCursor]!, rowTime);
        this.#dataCursor++;
      }
      for (const [topic, { row, timeNs: rowTime }] of this.#paths) {
        const candidates = (this.#snapshot.tracks ?? []).filter(
          (track): track is Extract<Track, { kind: "path" }> =>
            track.kind === "path" && track.selector.topic === topic,
        );
        if (candidates.length === 0) {
          continue;
        }
        const track = activeTrack(candidates, editTime);
        this.#renderer.updateConfig((draft) => {
          const settings = draft.topics[topic] ?? (draft.topics[topic] = {});
          settings.visible = track != undefined && trackOpacity(track, editTime) > 0;
          if (track != undefined) {
            const alpha = Math.round(trackOpacity(track, editTime) * 255)
              .toString(16)
              .padStart(2, "0");
            Object.assign(settings, {
              type: "line",
              lineWidth: track.style.widthMeters,
              gradient: [track.style.color + alpha, track.style.color + alpha],
            });
          }
        });
        const node = this.#native.paths?.settingsNodes().find((entry) => entry.path[1] === topic);
        node?.node.handler?.({
          action: "update",
          payload: {
            path: ["topics", topic, "visible"],
            input: "boolean",
            value: track != undefined && trackOpacity(track, editTime) > 0,
          },
        });
        this.#dispatch(row, rowTime);
      }
      this.#renderer.setCurrentTime(time);
      if (image != undefined && this.#lastImageId !== image.sourceFrameId) {
        const bytes = await verifiedFetch(
          new URL(assetPath(image.asset), this.#base),
          image.asset.sha256,
          image.asset.size,
        );
        requireValue(bytes.byteLength === image.asset.size, "Camera asset size mismatch");
        this.#dispatch(
          {
            timeNs: String(time),
            role: "data",
            event: {
              topic: this.#snapshot.recipe.source!.cameraTopic!,
              schemaName: "sensor_msgs/CompressedImage",
              receiveTime: {
                sec: Number(time / 1_000_000_000n),
                nsec: Number(time % 1_000_000_000n),
              },
              sizeInBytes: bytes.byteLength,
              message: {
                header: {
                  ...image.header,
                  stamp: {
                    sec: Number(time / 1_000_000_000n),
                    nsec: Number(time % 1_000_000_000n),
                  },
                },
                format: image.format,
                data: new Uint8Array(bytes),
              },
            },
          },
          time,
        );
        await this.#imageMode!.decodeOriginal(image);
      }
      await this.#renderer.settleVideoDecodes();
      await document.fonts.ready;
      for (const model of this.#snapshot.models ?? []) {
        const track = this.#snapshot.tracks?.find((value) => value.id === model.trackId);
        const native = this.#native.urdfs?.renderables.get(model.trackId);
        requireValue(
          track != undefined && native != undefined && native.userData.renderables.size > 0,
          "Frozen model did not finish loading",
        );
        native.userData.settings.visible = trackOpacity(track, editTime) > 0;
        this.#renderer.addTransform(
          model.frameId,
          model.framePrefix + "base_link",
          0n,
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0, w: 1 },
        );
      }
      this.#renderer.setCurrentTime(time);
      this.#renderer.animationFrame();
      const found = errors(this.#renderer.settings.errors.errors);
      requireValue(found.length === 0, found.slice(0, 8).join("; "));
      const targetWidth = image != undefined ? image.width : this.#snapshot.recipe.output.width;
      const targetHeight = image != undefined ? image.height : this.#snapshot.recipe.output.height;
      let width = targetWidth;
      let height = targetHeight;
      if (this.#output != undefined) {
        // Strict capture only: interactive frames stay on the GPU canvas and
        // never pay the 4K readback/2D copy.
        const gl = this.#renderer.gl.getContext();
        requireValue(gl instanceof WebGL2RenderingContext, "WebGL2 required");
        if (this.#capture?.width !== targetWidth || this.#capture.height !== targetHeight) {
          this.#capture = new ImageData(targetWidth, targetHeight);
          this.#readback = new Uint8Array(targetWidth * targetHeight * 4);
        }
        const capture = this.#capture;
        // putImageData copies synchronously, so both buffers are free again for the next frame.
        readFramePixels(gl, targetWidth, targetHeight, {
          readback: this.#readback!,
          output: capture.data,
        });
        this.#output.putImageData(capture, 0, 0);
        width = this.#output.canvas.width;
        height = this.#output.canvas.height;
      }
      this.#previousTime = time;
      this.#lastImageId = image != undefined ? image.sourceFrameId : `3d-${plan.frameIndex}`;
      return {
        ...plan,
        sourceFrameId: image != undefined ? image.sourceFrameId : `3d-${plan.frameIndex}`,
        cameraTimeNs: image != undefined ? image.cameraTimeNs : String(time),
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
