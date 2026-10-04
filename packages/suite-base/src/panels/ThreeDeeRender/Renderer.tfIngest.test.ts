/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { setupJestCanvasMock } from "jest-canvas-mock";

import { Asset } from "@lichtblick/suite-base/components/PanelExtensionAdapter";
import { Renderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/Renderer";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "@lichtblick/suite-base/panels/ThreeDeeRender/SceneExtensionConfig";
import { DEFAULT_CAMERA_STATE } from "@lichtblick/suite-base/panels/ThreeDeeRender/camera";
import * as normalizeMessages from "@lichtblick/suite-base/panels/ThreeDeeRender/normalizeMessages";
import { DEFAULT_PUBLISH_SETTINGS } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PublishSettings";

import { RendererConfig } from "./IRenderer";

jest.mock("@lichtblick/suite-base/panels/ThreeDeeRender/Picker", () => {
  const actual = jest.requireActual("@lichtblick/suite-base/panels/ThreeDeeRender/Picker");
  return {
    ...actual,
    Picker: jest.fn().mockImplementation(() => ({
      pick: jest.fn(() => -1),
      pickInstance: jest.fn(() => -1),
      dispose: jest.fn(),
    })),
  };
});

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");

jest.mock("three", () => {
  const ActualTHREE = jest.requireActual("three");
  return {
    ...ActualTHREE,
    WebGLRenderer: function WebGLRenderer() {
      return {
        capabilities: { isWebGL2: true },
        setPixelRatio: jest.fn(),
        getPixelRatio: jest.fn(() => 1),
        setSize: jest.fn(),
        render: jest.fn(),
        clear: jest.fn(),
        setClearColor: jest.fn(),
        readRenderTargetPixels: jest.fn(),
        info: { reset: jest.fn() },
        shadowMap: {},
        dispose: jest.fn(),
        clearDepth: jest.fn(),
        getDrawingBufferSize: () => ({ width: 100, height: 100 }),
      };
    },
  };
});

const config: RendererConfig = {
  cameraState: DEFAULT_CAMERA_STATE,
  followMode: "follow-pose",
  followTf: undefined,
  scene: {},
  transforms: {},
  topics: {},
  layers: {},
  publish: DEFAULT_PUBLISH_SETTINGS,
  imageMode: {},
};

const fetchAsset = async (uri: string): Promise<Asset> => ({
  uri,
  data: new Uint8Array(),
  mediaType: undefined,
});

type Stamp = { sec: number; nsec: number };

function tfMessageEvent(
  transforms: { parent: string; child: string; stamp: Stamp; x: number }[],
  message = {
    transforms: transforms.map(({ parent, child, stamp, x }) => ({
      header: { frame_id: parent, stamp, seq: 0 },
      child_frame_id: child,
      transform: {
        translation: { x, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0.6, w: 0.8 },
      },
    })),
  },
) {
  return {
    topic: "/xgc/tf",
    schemaName: "tf2_msgs/TFMessage",
    receiveTime: { sec: 0, nsec: 0 },
    message,
    sizeInBytes: 0,
  };
}

describe("TF ingestion across panels", () => {
  let parent: HTMLDivElement;
  const renderers: Renderer[] = [];

  // eslint-disable-next-line @lichtblick/no-boolean-parameters
  function panel(interfaceMode: "3d" | "image", ros = false): Renderer {
    const canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    const renderer = new Renderer({
      config,
      interfaceMode,
      fetchAsset,
      sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
      testOptions: {},
      customCameraModels: new Map(),
      canvas,
    });
    renderer.ros = ros;
    if (interfaceMode === "image") {
      // An image panel ingests TF only after leaving image-only subscription mode, as it does as
      // soon as its camera calibration topic resolves.
      renderer.disableImageOnlySubscriptionMode();
    }
    renderers.push(renderer);
    return renderer;
  }

  beforeEach(() => {
    setupJestCanvasMock();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
    parent = document.createElement("div");
  });

  afterEach(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.dispose();
    }
    (console.warn as jest.Mock).mockClear();
  });

  function deliver(renderer: Renderer, event: ReturnType<typeof tfMessageEvent>): void {
    renderer.setCurrentTime(10n);
    renderer.addMessageEvent(event);
    renderer.animationFrame();
  }

  it("decodes a message once for the 3D panel and the image panel that both receive it", () => {
    // Decoding a message starts with normalizing it; count how often that runs.
    const decode = jest.spyOn(normalizeMessages, "normalizeTFMessage");
    const threeD = panel("3d");
    const image = panel("image");
    const event = tfMessageEvent([
      { parent: "world", child: "robot_1/base_link", stamp: { sec: 5, nsec: 1 }, x: 1 },
      { parent: "world", child: "robot_2/base_link", stamp: { sec: 5, nsec: 2 }, x: 2 },
    ]);

    deliver(threeD, event);
    deliver(image, event);

    expect(decode).toHaveBeenCalledTimes(1);
    for (const renderer of [threeD, image]) {
      expect(renderer.transformTree.frame("robot_1/base_link")?.transformsSize()).toBe(1);
      expect(renderer.transformTree.frame("robot_2/base_link")?.parent()?.id).toBe("world");
      expect(renderer.transformTree.frame("robot_2/base_link")?.newestTransformTime()).toBe(
        5_000_000_002n,
      );
    }
    // A different message object is a different message.
    deliver(threeD, tfMessageEvent([{ parent: "world", child: "robot_1/base_link", stamp: { sec: 6, nsec: 0 }, x: 3 }]));
    expect(decode).toHaveBeenCalledTimes(2);
    decode.mockRestore();
  });

  it("stores the same pose per panel as adding the transform directly", () => {
    const viaMessage = panel("3d");
    const direct = panel("3d");
    const stamp = { sec: 7, nsec: 500 };
    deliver(
      viaMessage,
      tfMessageEvent([{ parent: "world", child: "robot/base_link", stamp, x: 4.25 }]),
    );
    direct.addTransform(
      "world",
      "robot/base_link",
      7_000_000_500n,
      { x: 4.25, y: 0, z: 0 },
      { x: 0, y: 0, z: 0.6, w: 0.8 },
    );

    const poseOf = (renderer: Renderer) => {
      const out = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
      const input = { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
      renderer.transformTree.apply(out, input, "world", "world", "robot/base_link", 7_000_000_500n, 7_000_000_500n);
      return out;
    };
    expect(poseOf(viaMessage)).toEqual(poseOf(direct));
    expect(poseOf(viaMessage).position.x).not.toBe(1);
  });

  it("keeps ROS and non-ROS frame id normalization apart even for one message object", () => {
    const ros = panel("3d", true);
    const plain = panel("3d", false);
    const event = tfMessageEvent([
      { parent: "/world", child: "/robot/base_link", stamp: { sec: 1, nsec: 0 }, x: 1 },
    ]);

    deliver(ros, event);
    deliver(plain, event);

    expect(ros.transformTree.hasFrame("robot/base_link")).toBe(true);
    expect(ros.transformTree.hasFrame("/robot/base_link")).toBe(false);
    expect(plain.transformTree.hasFrame("/robot/base_link")).toBe(true);
    expect(plain.transformTree.hasFrame("robot/base_link")).toBe(false);
  });

  it("reports an undecodable transform for each panel and still ingests the rest of the message", () => {
    const threeD = panel("3d");
    const image = panel("image");
    const event = tfMessageEvent([
      { parent: "world", child: "bad/base_link", stamp: { sec: 1.5, nsec: 0 }, x: 1 },
      { parent: "world", child: "good/base_link", stamp: { sec: 2, nsec: 0 }, x: 2 },
    ]);

    deliver(threeD, event);
    deliver(image, event);

    for (const renderer of [threeD, image]) {
      expect(renderer.transformTree.hasFrame("good/base_link")).toBe(true);
      expect(renderer.transformTree.frame("bad/base_link")?.transformsSize() ?? 0).toBe(0);
      const errors = renderer.settings.errors.errors.errorAtPath(["transforms"]);
      expect(errors).toContain("Error adding transform for frame bad/base_link");
    }
  });
});
