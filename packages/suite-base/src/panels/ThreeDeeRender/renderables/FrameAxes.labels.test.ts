/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { setupJestCanvasMock } from "jest-canvas-mock";

import { Renderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/Renderer";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "@lichtblick/suite-base/panels/ThreeDeeRender/SceneExtensionConfig";
import { DEFAULT_CAMERA_STATE } from "@lichtblick/suite-base/panels/ThreeDeeRender/camera";
import { DEFAULT_PUBLISH_SETTINGS } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PublishSettings";

import { FrameAxes } from "./FrameAxes";

const mockT = jest.fn();
jest.mock("i18next", () => {
  const actual = jest.requireActual("i18next");
  const instance = actual.default ?? actual;
  return {
    __esModule: true,
    ...actual,
    default: instance,
    t: (...args: unknown[]) => {
      mockT(...args);
      return instance.t(...args);
    },
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

const PER_FRAME_LABEL_KEYS = new Set([
  "threeDee:parent",
  "threeDee:age",
  "threeDee:historySize",
  "threeDee:translation",
  "threeDee:rotation",
  "threeDee:translationOffset",
  "threeDee:rotationOffset",
]);

describe("FrameAxes settings labels", () => {
  beforeEach(() => {
    setupJestCanvasMock();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
  });

  it("does not translate per-frame field labels for every frame on each rebuild", () => {
    const canvas = document.createElement("canvas");
    document.createElement("div").appendChild(canvas);
    const renderer = new Renderer({
      canvas,
      config: {
        cameraState: DEFAULT_CAMERA_STATE,
        followMode: "follow-pose",
        followTf: undefined,
        scene: { transforms: { editable: true } },
        transforms: {},
        topics: {},
        layers: {},
        publish: DEFAULT_PUBLISH_SETTINGS,
        imageMode: {},
      },
      interfaceMode: "3d",
      fetchAsset: jest.fn(),
      sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
      testOptions: {},
      customCameraModels: new Map(),
    });
    try {
      // A robot fleet's display tree: one world root and 60 child frames.
      for (let i = 0; i < 60; i++) {
        renderer.addTransform(
          "world",
          `robot_${i}/base_link`,
          0n,
          { x: i, y: 0, z: 0 },
          {
            x: 0,
            y: 0,
            z: 0,
            w: 1,
          },
        );
      }
      const frameAxes = renderer.sceneExtensions.get("foxglove.FrameAxes") as FrameAxes;
      const frameNodes = (entries: ReturnType<FrameAxes["settingsNodes"]>) =>
        Object.keys(entries[0]!.node.children ?? {}).filter((key) => key.startsWith("frame:"));

      frameAxes.settingsNodes();
      mockT.mockClear();
      const entries = frameAxes.settingsNodes();

      expect(frameNodes(entries)).toHaveLength(61);
      const child = entries[0]!.node.children!["frame:robot_7/base_link"]!;
      expect(child.fields?.parent?.label).toBe("Parent");
      expect(child.fields?.rpyCoefficient?.label).toBe("Rotation offset");
      // The rebuild still translates its own node labels, but no longer once per frame.
      const perFrameCalls = mockT.mock.calls.filter(([key]) =>
        PER_FRAME_LABEL_KEYS.has(key as string),
      );
      expect(perFrameCalls).toHaveLength(0);
    } finally {
      renderer.dispose();
      // The renderer reports the empty follow frame on construction.
      (console.warn as jest.Mock).mockClear();
    }
  });
});
