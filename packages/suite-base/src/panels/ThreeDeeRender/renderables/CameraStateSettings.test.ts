/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { setupJestCanvasMock } from "jest-canvas-mock";
import * as THREE from "three";

import { Asset } from "@lichtblick/suite-base/components/PanelExtensionAdapter";
import { Renderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/Renderer";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "@lichtblick/suite-base/panels/ThreeDeeRender/SceneExtensionConfig";
import {
  DEFAULT_CAMERA_STATE,
  DEFAULT_ORBIT_CONTROLS_CONFIG,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/camera";
import { DEFAULT_PUBLISH_SETTINGS } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PublishSettings";

import { RendererConfig } from "../IRenderer";
import { CameraStateSettings } from "./CameraStateSettings";

let mockOrbitControls!: {
  screenSpacePanning: boolean;
  mouseButtons: { LEFT: number; RIGHT: number };
  touches: { ONE: number; TWO: number };
  keys: { LEFT: string; RIGHT: string; UP: string; BOTTOM: string };
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  listenToKeyEvents: jest.Mock;
  dispose: jest.Mock;
  getDistance: jest.Mock;
  getPolarAngle: jest.Mock;
  getAzimuthalAngle: jest.Mock;
  target: THREE.Vector3;
  update: jest.Mock;
  minPolarAngle: number;
  maxPolarAngle: number;
};

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: undefined,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");

jest.mock("three/examples/jsm/controls/OrbitControls", () => ({
  OrbitControls: jest.fn().mockImplementation(() => mockOrbitControls),
}));

jest.mock("three", () => {
  const ActualTHREE = jest.requireActual("three");
  return {
    ...ActualTHREE,
    WebGLRenderer: function WebGLRenderer() {
      return {
        capabilities: {
          isWebGL2: true,
        },
        setPixelRatio: jest.fn(),
        setSize: jest.fn(),
        render: jest.fn(),
        clear: jest.fn(),
        setClearColor: jest.fn(),
        readRenderTargetPixels: jest.fn(),
        info: {
          reset: jest.fn(),
        },
        shadowMap: {},
        dispose: jest.fn(),
        clearDepth: jest.fn(),
        getDrawingBufferSize: () => ({ width: 100, height: 100 }),
      };
    },
  };
});

function setupOrbitControlsMock() {
  mockOrbitControls = {
    ...DEFAULT_ORBIT_CONTROLS_CONFIG,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    listenToKeyEvents: jest.fn(),
    dispose: jest.fn(),
    getDistance: jest.fn().mockReturnValue(DEFAULT_CAMERA_STATE.distance),
    getPolarAngle: jest.fn().mockReturnValue(THREE.MathUtils.degToRad(DEFAULT_CAMERA_STATE.phi)),
    getAzimuthalAngle: jest
      .fn()
      .mockReturnValue(THREE.MathUtils.degToRad(-DEFAULT_CAMERA_STATE.thetaOffset)),
    target: new THREE.Vector3(...DEFAULT_CAMERA_STATE.targetOffset),
    update: jest.fn(),
    minPolarAngle: 0,
    maxPolarAngle: Math.PI,
  };
}

function getControlsHandler(event: string): () => void {
  const calls = mockOrbitControls.addEventListener.mock.calls as [string, unknown][];
  const handler = calls.find(([type]) => type === event)?.[1];
  if (typeof handler !== "function") {
    throw new Error(`OrbitControls handler for "${event}" was not registered`);
  }
  return handler as () => void;
}

const defaultRendererConfig: RendererConfig = {
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

const fetchAsset = async (uri: string, options?: { signal?: AbortSignal }): Promise<Asset> => {
  const response = await fetch(uri, options);
  return {
    uri,
    data: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get("content-type") ?? undefined,
  };
};

const defaultRendererProps = {
  config: defaultRendererConfig,
  interfaceMode: "3d" as const,
  fetchAsset,
  sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
  testOptions: {},
  customCameraModels: new Map(),
};

describe("CameraStateSettings", () => {
  let canvas: HTMLCanvasElement;
  let parent: HTMLDivElement;
  let renderer: Renderer;

  beforeEach(() => {
    jest.clearAllMocks();
    setupJestCanvasMock();
    setupOrbitControlsMock();
    parent = document.createElement("div");
    canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    renderer = new Renderer({ ...defaultRendererProps, canvas });
  });

  afterEach(() => {
    renderer.dispose();
    (console.warn as jest.Mock).mockClear(); // Suppress warnings from the Renderer during tests, if any
  });

  describe("constructor", () => {
    it("creates an instance with correct default settings", () => {
      // Given
      const aspect = 16 / 9;

      // When
      const cameraStateSettings = new CameraStateSettings(renderer, canvas, aspect);
      cameraStateSettings.setCameraState(DEFAULT_CAMERA_STATE);

      // Then
      expect(cameraStateSettings).toBeInstanceOf(CameraStateSettings);
      expect(cameraStateSettings.getActiveCamera().type).toBe("PerspectiveCamera");
      expect(cameraStateSettings.getCameraState()).toMatchObject({
        ...DEFAULT_CAMERA_STATE,
        distance: expect.closeTo(DEFAULT_CAMERA_STATE.distance), // floating point comparisons
        phi: expect.closeTo(DEFAULT_CAMERA_STATE.phi),
        thetaOffset: expect.closeTo(DEFAULT_CAMERA_STATE.thetaOffset),
      });
      expect(cameraStateSettings.settingsNodes()).toHaveLength(2);
    });
  });

  it("refreshes camera fields only for display-frame errors and their clears", () => {
    const settings = renderer.cameraHandler;
    const update = jest.spyOn(settings, "updateSettingsTree");
    const errors = renderer.settings.errors;
    errors.add(["layers", "robot"], "MISSING_TRANSFORM", "Missing model link");
    errors.remove(["layers", "robot"], "MISSING_TRANSFORM");
    errors.clearPath(["layers"]);
    expect(update).not.toHaveBeenCalled();

    errors.add(["general", "followTf"], "test-frame", "Missing display frame");
    expect(update).toHaveBeenCalledTimes(1);
    errors.remove(["general", "followTf"], "test-frame");
    expect(update).toHaveBeenCalledTimes(2);
    errors.add(["general", "followTf"], "test-frame", "Missing display frame");
    errors.clearPath(["general"]);
    expect(update).toHaveBeenCalledTimes(4);
    errors.add(["general", "followTf"], "test-frame", "Missing display frame");
    errors.clear();
    expect(update).toHaveBeenCalledTimes(6);
  });

  describe("cameraMove settings updates", () => {
    it("rebuilds the settings tree on cameraMove when not interacting with the controls", () => {
      // Given
      const settings = renderer.cameraHandler;
      const update = jest.spyOn(settings, "updateSettingsTree");

      // When
      renderer.emit("cameraMove", renderer);

      // Then
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("defers the settings tree rebuild during a drag until the controls interaction ends", () => {
      // Given
      const settings = renderer.cameraHandler;
      const update = jest.spyOn(settings, "updateSettingsTree");

      // When: an interaction starts and the camera moves every frame
      getControlsHandler("start")();
      renderer.emit("cameraMove", renderer);
      renderer.emit("cameraMove", renderer);

      // Then: no rebuild happens mid-interaction
      expect(update).not.toHaveBeenCalled();

      // When: the interaction ends
      getControlsHandler("end")();

      // Then: the tree is rebuilt once with the final camera values
      expect(update).toHaveBeenCalledTimes(1);

      // And: after the interaction, cameraMove refreshes immediately again
      renderer.emit("cameraMove", renderer);
      expect(update).toHaveBeenCalledTimes(2);
    });
  });

  describe("dispose", () => {
    it("disposes OrbitControls and removes its canvas keyboard listeners", () => {
      // Given
      const addSpy = jest.spyOn(canvas, "addEventListener");
      const removeSpy = jest.spyOn(canvas, "removeEventListener");
      const settings = new CameraStateSettings(renderer, canvas, 16 / 9);
      const keydownHandler = addSpy.mock.calls.find(([type]) => type === "keydown")?.[1];
      const keyupHandler = addSpy.mock.calls.find(([type]) => type === "keyup")?.[1];
      expect(keydownHandler).toBeDefined();
      expect(keyupHandler).toBeDefined();

      // When
      settings.dispose();

      // Then
      expect(mockOrbitControls.dispose).toHaveBeenCalledTimes(1);
      expect(mockOrbitControls.removeEventListener).toHaveBeenCalledWith(
        "change",
        expect.any(Function),
      );
      expect(mockOrbitControls.removeEventListener).toHaveBeenCalledWith(
        "start",
        expect.any(Function),
      );
      expect(mockOrbitControls.removeEventListener).toHaveBeenCalledWith(
        "end",
        expect.any(Function),
      );
      expect(removeSpy).toHaveBeenCalledWith("keydown", keydownHandler);
      expect(removeSpy).toHaveBeenCalledWith("keyup", keyupHandler);
    });
  });

  describe("screen space panning", () => {
    const aspect = 16 / 9;

    it("defaults to screen space panning disabled", () => {
      // Given: A newly constructed CameraStateSettings instance
      new CameraStateSettings(renderer, canvas, aspect);

      // Then: Screen space panning should be disabled by default
      expect(mockOrbitControls.screenSpacePanning).toBe(false);
    });

    it("enables screen space panning when Alt key is held", () => {
      // Given: A CameraStateSettings instance with canvas keyboard listeners attached
      new CameraStateSettings(renderer, canvas, aspect);

      // When: A keydown event fires with the Alt key held
      canvas.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, bubbles: true }));

      // Then: Screen space panning should be enabled
      expect(mockOrbitControls.screenSpacePanning).toBe(true);
    });

    it("disables screen space panning when Alt key is released", () => {
      // Given: A CameraStateSettings instance with Alt key already held
      new CameraStateSettings(renderer, canvas, aspect);
      canvas.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, bubbles: true }));

      // When: A keyup event fires without the Alt key
      canvas.dispatchEvent(new KeyboardEvent("keyup", { altKey: false, bubbles: true }));

      // Then: Screen space panning should be disabled again
      expect(mockOrbitControls.screenSpacePanning).toBe(false);
    });

    it("does not enable screen space panning on keydown without Alt", () => {
      // Given: A CameraStateSettings instance with canvas keyboard listeners attached
      new CameraStateSettings(renderer, canvas, aspect);

      // When: A keydown event fires without the Alt key
      canvas.dispatchEvent(new KeyboardEvent("keydown", { altKey: false, bubbles: true }));

      // Then: Screen space panning should remain disabled
      expect(mockOrbitControls.screenSpacePanning).toBe(false);
    });
  });
});
