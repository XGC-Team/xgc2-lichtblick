/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import "@testing-library/jest-dom";
import { act, render, waitFor } from "@testing-library/react";

import { Topic } from "@lichtblick/suite";
import { EMBEDDED_NAVIGATION_EVENT } from "@lichtblick/suite-base/components/EmbeddedWorkspaceBridge";
import { BuiltinPanelExtensionContext } from "@lichtblick/suite-base/components/PanelExtensionAdapter";
import { useAnalytics } from "@lichtblick/suite-base/context/AnalyticsContext";
import {
  DEFAULT_FOLLOW_MODE,
  MAX_TRANSFORM_MESSAGES,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/constants";
import type { MessageEvent } from "@lichtblick/suite-base/players/types";
import MessageEventBuilder from "@lichtblick/suite-base/testing/builders/MessageEventBuilder";
import RenderStateBuilder from "@lichtblick/suite-base/testing/builders/RenderStateBuilder";

import { Renderer } from "./Renderer";
import type { RendererOverlay } from "./RendererOverlay";
import { ThreeDeeRender } from "./ThreeDeeRender";
import { DEFAULT_CAMERA_STATE } from "./camera";
import type { PublishClickEventMap } from "./renderables/PublishClickTool";
import type { InterfaceMode, ThreeDeeRenderProps } from "./types";

// three.js modules
jest.mock("./ModelCache", () => ({
  ModelCache: jest.fn(),
}));

jest.mock("./SceneExtensionConfig", () => ({
  DEFAULT_SCENE_EXTENSION_CONFIG: {},
}));

jest.mock("@lichtblick/suite-base/context/AnalyticsContext", () => ({
  useAnalytics: jest.fn(),
}));

const createMockRenderer = (overrides?: Record<string, any>) => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const defaultRenderer = {
    dispose: jest.fn(),
    config: {},
    setTopics: jest.fn(),
    setParameters: jest.fn(),
    setCurrentTime: jest.fn(),
    handleSeek: jest.fn(),
    setColorScheme: jest.fn(),
    handleAllFramesMessages: jest.fn(),
    addMessageEvent: jest.fn(),
    setCameraState: jest.fn(),
    updateConfig: jest.fn(),
    getCameraState: jest.fn().mockReturnValue(undefined),
    animationFrame: jest.fn(),
    addListener: jest.fn((event: string, listener: (...args: any[]) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(listener);
    }),
    removeListener: jest.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
    emit: (event: string, ...args: unknown[]) => {
      listeners.get(event)?.forEach((listener) => {
        listener(...args);
      });
    },
    topicSubscriptions: new Map(),
    schemaSubscriptions: new Map(),
    settings: {
      handleAction: jest.fn(),
      tree: jest.fn().mockReturnValue({}),
      errors: {
        on: jest.fn(),
        off: jest.fn(),
      },
    },
    getDropStatus: jest.fn(),
    handleDrop: jest.fn(),
    setAnalytics: jest.fn(),
    setCustomCameraModels: jest.fn(),
    setCameraSyncError: jest.fn(),
    followFrameId: "base_link",
    fixedFrameId: "world",
    ros: false,
    currentTime: undefined,
    measurementTool: {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      startMeasuring: jest.fn(),
      stopMeasuring: jest.fn(),
    },
    publishClickTool: {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      setPublishClickType: jest.fn(),
      publishClickType: "point",
    },
    settleVideoDecodes: jest.fn().mockResolvedValue(undefined),
  };

  return { ...defaultRenderer, ...overrides };
};

jest.mock("./Renderer", () => ({
  Renderer: jest.fn().mockImplementation(() => createMockRenderer()),
}));

jest.mock("@lichtblick/suite-base/theme/ThemeProvider", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

let mockOverlayProps: React.ComponentProps<typeof RendererOverlay>;
jest.mock("./RendererOverlay", () => ({
  RendererOverlay: (props: React.ComponentProps<typeof RendererOverlay>) => {
    mockOverlayProps = props;
    return <div data-testid="renderer-overlay">Renderer Overlay</div>;
  },
}));

const createMockContext = (
  overrides: Partial<BuiltinPanelExtensionContext> = {},
): BuiltinPanelExtensionContext => {
  return {
    initialState: {},
    saveState: jest.fn(),
    watch: jest.fn(),
    onRender: undefined,
    subscribe: jest.fn(),
    unsubscribeAll: jest.fn(),
    updatePanelSettingsEditor: jest.fn(),
    setDefaultPanelTitle: jest.fn(),
    unstable_fetchAsset: jest.fn(),
    unstable_setMessagePathDropConfig: jest.fn(),
    unstable_subscribeMessageRange: jest.fn(),
    dataSourceProfile: "ros1",
    layout: {
      addPanel: jest.fn(),
    },
    setVariable: jest.fn(),
    setSharedPanelState: jest.fn(),
    advertise: jest.fn(),
    unadvertise: jest.fn(),
    publish: jest.fn(),
    subscribeAppSettings: jest.fn(),
    ...overrides,
  } as BuiltinPanelExtensionContext;
};

function buildTfMessages({
  topic = "/tf",
  count,
  startSec = 100,
  startNsec = 0,
  schemaName = "tf2_msgs/TFMessage",
  sizeInBytes = 100,
}: {
  count: number;
  topic?: string;
  startSec?: number;
  startNsec?: number;
  schemaName?: string;
  sizeInBytes?: number;
}): MessageEvent[] {
  return Array.from({ length: count }, (_, i) =>
    MessageEventBuilder.messageEvent({
      topic,
      message: { transforms: [] },
      schemaName,
      sizeInBytes,
      receiveTime: {
        sec: startSec,
        nsec: startNsec + i,
      },
    }),
  );
}

describe("ThreeDeeRender", () => {
  const mockAnalytics = { logEvent: jest.fn() };
  const mockedRenderer = jest.mocked(Renderer);

  const setup = (
    propsOverrides?: Partial<Omit<ThreeDeeRenderProps, "context">>,
    contextOrOverrides?: BuiltinPanelExtensionContext | Partial<BuiltinPanelExtensionContext>,
  ): ThreeDeeRenderProps => {
    // If contextOrOverrides has 'onRender' property (even if undefined), treat it as a full context
    const context =
      contextOrOverrides && "watch" in contextOrOverrides && "subscribe" in contextOrOverrides
        ? (contextOrOverrides as BuiltinPanelExtensionContext)
        : createMockContext(contextOrOverrides);
    return {
      context,
      interfaceMode: "3d",
      testOptions: {},
      customCameraModels: new Map(),
      ...propsOverrides,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (useAnalytics as jest.Mock).mockReturnValue(mockAnalytics);

    // WebGL context
    HTMLCanvasElement.prototype.getContext = jest.fn().mockReturnValue({
      canvas: document.createElement("canvas"),
      drawArrays: jest.fn(),
      clearColor: jest.fn(),
      clear: jest.fn(),
      viewport: jest.fn(),
    });
  });

  it("renders without crashing", () => {
    // Given
    const props = setup();

    // When
    const { container } = render(<ThreeDeeRender {...props} />);

    // Then
    expect(container).toBeInTheDocument();
  });

  it("renders a canvas element", () => {
    // Given
    const props = setup();

    // When
    const { container } = render(<ThreeDeeRender {...props} />);

    // Then
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeInTheDocument();
  });

  it("renders the RendererOverlay component", () => {
    const props = setup();

    const { getByTestId } = render(<ThreeDeeRender {...props} />);
    expect(getByTestId("renderer-overlay")).toBeInTheDocument();
  });

  it("uses native follow state and the original goal click tool only on UI input", () => {
    const props = setup(
      {},
      { initialState: { followTf: "xgc/robots/uav1/base_link", followMode: "follow-position" } },
    );
    render(<ThreeDeeRender {...props} />);
    const renderer = mockedRenderer.mock.results[0]!.value;
    act(() => {
      mockOverlayProps.onFollowRobot("xgc/robots/uav1/base_link");
    });
    expect(renderer.settings.handleAction).toHaveBeenCalledWith({
      action: "update",
      payload: {
        input: "select",
        path: ["general", "followTf"],
        value: "xgc/robots/uav1/base_link",
      },
    });
    expect(renderer.settings.handleAction).toHaveBeenCalledWith({
      action: "update",
      payload: { input: "select", path: ["general", "followMode"], value: "follow-position" },
    });
    act(() => {
      mockOverlayProps.onGoal();
    });
    expect(renderer.settings.handleAction).toHaveBeenCalledWith({
      action: "update",
      payload: { input: "select", path: ["general", "followTf"], value: "world" },
    });
    expect(renderer.publishClickTool.setPublishClickType).toHaveBeenCalledWith("pose");
    expect(renderer.publishClickTool.start).toHaveBeenCalledTimes(1);
    expect(jest.spyOn(props.context, "publish")).not.toHaveBeenCalled();
    expect(renderer.addListener).not.toHaveBeenCalledWith(
      "transformTreeUpdated",
      expect.any(Function),
    );
  });

  it("uses native navigation and reads robot roots only when Follow opens", () => {
    const frames = [{ label: "uav1", value: "xgc/robots/uav1/base_link" }];
    const robotFollowFrames = jest.fn().mockReturnValue(frames);
    mockedRenderer.mockImplementationOnce(
      () =>
        createMockRenderer({
          sceneExtensions: new Map([["foxglove.Urdfs", { robotFollowFrames }]]),
        }) as unknown as Renderer,
    );
    const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
    const props = setup(
      { embeddedPanelId: "ThreeDeeRender!native-test" },
      {
        dataSourceIsLive: true,
        initialState: { followTf: "xgc/robots/uav1/base_link", followMode: "follow-position" },
      },
    );
    const view = render(<ThreeDeeRender {...props} />);
    const renderer = mockedRenderer.mock.results[0]!.value;
    const element = view.container.querySelector("[data-xgc-native-3d-panel-id]")!;
    const navigate = (action: string, frameId?: string) => {
      act(() => {
        element.dispatchEvent(
          new CustomEvent(EMBEDDED_NAVIGATION_EVENT, {
            detail: { panelId: "ThreeDeeRender!native-test", action, frameId },
          }),
        );
      });
    };
    expect(robotFollowFrames).not.toHaveBeenCalled();
    navigate("robot-frames");
    expect(robotFollowFrames).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "robot-frames",
        panelId: "ThreeDeeRender!native-test",
        frames,
      }),
      window.location.origin,
    );
    navigate("follow", "xgc/robots/uav1/base_link");
    expect(renderer.settings.handleAction).toHaveBeenCalledWith({
      action: "update",
      payload: {
        input: "select",
        path: ["general", "followTf"],
        value: "xgc/robots/uav1/base_link",
      },
    });
    expect(renderer.settings.handleAction).toHaveBeenCalledWith({
      action: "update",
      payload: { input: "select", path: ["general", "followMode"], value: "follow-position" },
    });
    navigate("goal");
    expect(renderer.settings.handleAction).toHaveBeenCalledWith({
      action: "update",
      payload: { input: "select", path: ["general", "followTf"], value: "world" },
    });
    expect(renderer.publishClickTool.setPublishClickType).toHaveBeenCalledWith("pose");
    expect(renderer.publishClickTool.start).toHaveBeenCalledTimes(1);
    expect(jest.spyOn(props.context, "publish")).not.toHaveBeenCalled();
    navigate("overview");
    expect(renderer.settings.handleAction).toHaveBeenCalledWith({
      action: "update",
      payload: { input: "select", path: ["general", "followMode"], value: "follow-none" },
    });
    expect(robotFollowFrames).toHaveBeenCalledTimes(1);
    postMessage.mockRestore();
    expect(renderer.addListener).not.toHaveBeenCalledWith(
      "transformTreeUpdated",
      expect.any(Function),
    );
  });

  it("does not withdraw a connected replacement native panel when the old root retires late", () => {
    const originalParent = Object.getOwnPropertyDescriptor(window, "parent")!;
    const postMessage = jest.fn();
    Object.defineProperty(window, "parent", { configurable: true, value: { postMessage } });
    const embeddedPanelId = "ThreeDeeRender!replacement";
    try {
      const old = render(<ThreeDeeRender {...setup({ embeddedPanelId })} />);
      // Adapter removes the old container synchronously; nested root.unmount runs later.
      old.container.remove();
      const current = render(<ThreeDeeRender {...setup({ embeddedPanelId })} />);
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "navigation-state",
          panelId: embeddedPanelId,
          available: true,
        }),
        window.location.origin,
      );
      postMessage.mockClear();
      old.unmount();
      expect(postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: "navigation-state",
          available: false,
        }),
        expect.any(String),
      );
      current.unmount();
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "navigation-state",
          panelId: embeddedPanelId,
          available: false,
        }),
        window.location.origin,
      );
    } finally {
      Object.defineProperty(window, "parent", originalParent);
    }
  });

  it("reports a synchronous Goal publish failure with the configured topic and reason", () => {
    const failure = new Error("No advertised channel");
    const enqueueSnackbarFromParent = jest.fn();
    const logError = jest.fn();
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    const props = setup(
      { enqueueSnackbarFromParent, logError },
      {
        initialState: { publish: { poseTopic: "/chosen/goal" } },
        publish: jest.fn(() => {
          throw failure;
        }),
      },
    );
    render(<ThreeDeeRender {...props} />);
    const renderer = mockedRenderer.mock.results[0]!.value;
    const onSubmit = jest
      .mocked(renderer.publishClickTool.addEventListener)
      .mock.calls.find(([type]) => type === "foxglove.publish-submit")![1] as unknown as (
      event: PublishClickEventMap["foxglove.publish-submit"],
    ) => void;
    const pose = { position: { x: 1, y: 2, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    act(() => {
      onSubmit({ publishClickType: "pose", pose });
    });
    expect(jest.spyOn(props.context, "publish")).toHaveBeenCalledTimes(1);
    expect(jest.spyOn(props.context, "publish")).toHaveBeenCalledWith(
      "/chosen/goal",
      expect.objectContaining({
        header: expect.objectContaining({ frame_id: "base_link" }),
        pose,
      }),
    );
    const message = "Failed to publish pose to /chosen/goal in base_link: No advertised channel";
    expect(enqueueSnackbarFromParent).toHaveBeenCalledWith(message, "error");
    expect(logError).toHaveBeenCalledWith(message, failure);
    consoleError.mockRestore();
  });

  it.each([
    true,
    false,
  ])("switches the actual camera through native settings with syncCamera=%s", (syncCamera) => {
    let cameraState = { ...DEFAULT_CAMERA_STATE };
    const handleAction = jest.fn((action) => {
      if (action.payload.path.join(".") === "cameraState.perspective") {
        cameraState = { ...cameraState, perspective: action.payload.value };
      }
    });
    mockedRenderer.mockImplementationOnce(
      () =>
        createMockRenderer({
          getCameraState: jest.fn(() => cameraState),
          settings: {
            handleAction,
            tree: jest.fn(() => ({})),
            errors: { on: jest.fn(), off: jest.fn() },
          },
        }) as unknown as Renderer,
    );
    const props = setup({}, { initialState: { scene: { syncCamera } } });
    render(<ThreeDeeRender {...props} />);
    act(() => {
      mockOverlayProps.onTogglePerspective();
    });
    expect(cameraState.perspective).toBe(false);
    const sharedState = { cameraState, followMode: DEFAULT_FOLLOW_MODE, followTf: "base_link" };
    expect(jest.spyOn(props.context, "setSharedPanelState").mock.calls).toEqual(
      syncCamera ? [[sharedState]] : [],
    );
    act(() => {
      mockOverlayProps.onTogglePerspective();
    });
    expect(cameraState.perspective).toBe(true);
    const nextSharedState = { cameraState, followMode: DEFAULT_FOLLOW_MODE, followTf: "base_link" };
    expect(jest.spyOn(props.context, "setSharedPanelState").mock.calls).toEqual(
      syncCamera ? [[sharedState], [nextSharedState]] : [],
    );
  });

  it("publishes the selected native point and Goal to configured ROS topics with their actual frame", () => {
    mockedRenderer.mockImplementationOnce(() => {
      const renderer = createMockRenderer();
      renderer.settings.handleAction.mockImplementation((action) => {
        if (action.payload.path.join(".") === "general.followTf") {
          renderer.followFrameId = action.payload.value;
        }
      });
      return renderer as unknown as Renderer;
    });
    const props = setup(
      {},
      { initialState: { publish: { pointTopic: "/chosen/point", poseTopic: "/chosen/goal" } } },
    );
    const view = render(<ThreeDeeRender {...props} />);
    const renderer = mockedRenderer.mock.results[0]!.value;
    expect(jest.spyOn(props.context, "advertise")).toHaveBeenCalledWith(
      "/chosen/point",
      "geometry_msgs/PointStamped",
      expect.any(Object),
    );
    expect(jest.spyOn(props.context, "advertise")).toHaveBeenCalledWith(
      "/chosen/goal",
      "geometry_msgs/PoseStamped",
      expect.any(Object),
    );
    const onSubmit = jest
      .mocked(renderer.publishClickTool.addEventListener)
      .mock.calls.find(([type]) => type === "foxglove.publish-submit")![1] as unknown as (
      event: PublishClickEventMap["foxglove.publish-submit"],
    ) => void;
    const point = { x: 1, y: 2, z: 0 };
    act(() => {
      onSubmit({ publishClickType: "point", point });
    });
    expect(jest.spyOn(props.context, "publish")).toHaveBeenLastCalledWith(
      "/chosen/point",
      expect.objectContaining({
        header: expect.objectContaining({ frame_id: "base_link" }),
        point,
      }),
    );
    act(() => {
      mockOverlayProps.onGoal();
    });
    const pose = { position: { x: 3, y: 4, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    act(() => {
      onSubmit({ publishClickType: "pose", pose });
    });
    expect(jest.spyOn(props.context, "publish")).toHaveBeenLastCalledWith(
      "/chosen/goal",
      expect.objectContaining({ header: expect.objectContaining({ frame_id: "world" }), pose }),
    );
    view.unmount();
    expect(jest.spyOn(props.context, "unadvertise")).toHaveBeenCalledWith("/chosen/point");
    expect(jest.spyOn(props.context, "unadvertise")).toHaveBeenCalledWith("/chosen/goal");
  });

  it("initializes with default camera state when no initial state is provided", () => {
    // Given
    const props = setup();

    // When
    const { container } = render(<ThreeDeeRender {...props} />);
    expect(container).toBeInTheDocument();

    // Then
    expect(mockedRenderer).toHaveBeenCalled();
    const rendererConfig = mockedRenderer.mock.calls[0]?.[0]?.config;
    expect(rendererConfig?.cameraState).toMatchObject(DEFAULT_CAMERA_STATE);
    expect(rendererConfig?.followMode).toBe(DEFAULT_FOLLOW_MODE);
    expect(rendererConfig?.followTf).toBeUndefined();
  });

  it("initializes with custom camera state when an initial state is provided", () => {
    // Given
    const customCameraState = {
      cameraState: {
        perspective: true,
        distance: 10,
        far: 1000,
        fovy: 50,
        near: 0.5,
        phi: 45,
        thetaOffset: 90,
        target: [0, 0, 0],
        targetOffset: [0, 0, 0],
        targetOrientation: [0, 0, 0, 1],
      },
      followMode: "follow-position" as const,
      followTf: "base_link",
    };
    const props = setup({}, { initialState: customCameraState });

    // When
    const { container } = render(<ThreeDeeRender {...props} />);

    // Then
    expect(container).toBeInTheDocument();

    expect(mockedRenderer).toHaveBeenCalled();
    const rendererConfig = mockedRenderer.mock.calls[0]?.[0]?.config;
    expect(rendererConfig?.cameraState).toEqual(customCameraState.cameraState);
    expect(rendererConfig?.followMode).toBe(customCameraState.followMode);
    expect(rendererConfig?.followTf).toBe(customCameraState.followTf);
  });

  it("initializes with image interface mode", () => {
    // Given
    const initialState = {
      interfaceMode: "image" as InterfaceMode,
    };
    const props = setup({ ...initialState });

    // When
    const { container } = render(<ThreeDeeRender {...props} />);

    // Then
    expect(container).toBeInTheDocument();
    expect(mockedRenderer).toHaveBeenCalled();
    const rendererCall = mockedRenderer.mock.calls[0]?.[0];
    expect(rendererCall?.interfaceMode).toBe(initialState.interfaceMode);
  });

  it("passes custom scene extensions to renderer", () => {
    const customSceneExtensions = {
      extensionsById: {
        "foxglove.SceneSettings": {
          init: (renderer: any) => renderer,
          supportedInterfaceModes: ["3d" as const],
        },
      },
    };
    const props = setup({ customSceneExtensions });

    const { container } = render(<ThreeDeeRender {...props} />);
    expect(container).toBeInTheDocument();

    expect(mockedRenderer).toHaveBeenCalled();
    const rendererCall = mockedRenderer.mock.calls[0]?.[0];
    expect(rendererCall?.sceneExtensionConfig).toMatchObject(customSceneExtensions);
  });

  it("renders with custom camera models", () => {
    const mockCameraModelBuilder = (info: any) => ({
      width: info.width,
      height: info.height,
      fx: 100,
      fy: 100,
      cx: 50,
      cy: 50,
      projectPixelTo3dPlane: jest.fn(),
      projectPixelTo3dRay: jest.fn(),
    });

    const customCameraModels = new Map([
      [
        "custom_test_model",
        { extensionId: "test-extension", modelBuilder: mockCameraModelBuilder },
      ],
    ]);

    const props = setup({ customCameraModels });

    const { container } = render(<ThreeDeeRender {...props} />);
    expect(container).toBeInTheDocument();
    expect(mockedRenderer).toHaveBeenCalled();
    const rendererCall = mockedRenderer.mock.calls[0]?.[0];
    expect(rendererCall?.customCameraModels).toBe(customCameraModels);
  });

  describe("seek render barrier", () => {
    function deferred<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    it("invokes done immediately for non-seek frames", async () => {
      const customRendererInstance = createMockRenderer();
      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createMockContext();
      const props = setup({}, mockContext);
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(mockContext.onRender).toBeDefined();
      });

      const done = jest.fn();
      act(() => {
        mockContext.onRender!(
          {
            topics: [],
            currentFrame: [],
            currentTime: { sec: 0, nsec: 1 },
          },
          done,
        );
      });

      await waitFor(() => {
        expect(done).toHaveBeenCalledTimes(1);
      });
      expect(customRendererInstance.settleVideoDecodes).not.toHaveBeenCalled();
    });

    it("defers done on seek frames until video decode settles", async () => {
      const settle = deferred<void>();
      const customRendererInstance = createMockRenderer({
        settleVideoDecodes: jest.fn().mockImplementation(async () => {
          await settle.promise;
        }),
      });
      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createMockContext();
      const props = setup({}, mockContext);
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(mockContext.onRender).toBeDefined();
      });

      const done = jest.fn();
      act(() => {
        mockContext.onRender!(
          {
            topics: [],
            currentFrame: [],
            currentTime: { sec: 0, nsec: 2 },
            didSeek: true,
          },
          done,
        );
      });

      await waitFor(() => {
        expect(customRendererInstance.settleVideoDecodes).toHaveBeenCalledTimes(1);
      });
      expect(done).not.toHaveBeenCalled();

      await act(async () => {
        settle.resolve();
        await settle.promise;
      });

      expect(done).toHaveBeenCalledTimes(1);
    });

    it("releases done when settleVideoDecodes rejects", async () => {
      const settle = deferred<void>();
      const customRendererInstance = createMockRenderer({
        settleVideoDecodes: jest.fn().mockImplementation(async () => {
          await settle.promise;
        }),
      });
      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createMockContext();
      const props = setup({}, mockContext);
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(mockContext.onRender).toBeDefined();
      });

      const done = jest.fn();
      act(() => {
        mockContext.onRender!(
          {
            topics: [],
            currentFrame: [],
            currentTime: { sec: 0, nsec: 3 },
            didSeek: true,
          },
          done,
        );
      });

      await waitFor(() => {
        expect(customRendererInstance.settleVideoDecodes).toHaveBeenCalledTimes(1);
      });
      expect(done).not.toHaveBeenCalled();

      await act(async () => {
        settle.reject(new Error("decode failed"));
        await Promise.resolve();
      });

      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  describe("transfom topic preloading", () => {
    const mockUnsubscribe = jest.fn();
    const createPreloadingContext = (overrides?: {
      onSubscribe?: (args: any) => (() => void) | void;
      initialState?: any;
    }) => {
      return createMockContext({
        initialState: {
          scene: {
            transforms: {
              enablePreloading: true,
            },
          },
          topics: {
            "/tf": { visible: true },
            "/tf_static": { visible: true },
            "/new_topic": { visible: true },
          },
          ...overrides?.initialState,
        },
        unstable_subscribeMessageRange: jest.fn((args: any) => {
          const customUnsubscribe = overrides?.onSubscribe?.(args);
          return customUnsubscribe ?? mockUnsubscribe;
        }),
      });
    };

    it("does not trigger if transform preloading is disabled", async () => {
      // Given
      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([
          [
            "tf2_msgs/TFMessage",
            [
              {
                preload: false,
              },
            ],
          ],
        ]),
      });
      const topics = [
        RenderStateBuilder.topic({ name: "/tf", schemaName: "tf2_msgs/TFMessage" }),
        RenderStateBuilder.topic({ name: "/other", schemaName: "std_msgs/String" }),
      ];
      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        onSubscribe: () => mockUnsubscribe,
      });

      const props = setup({}, mockContext);

      // When
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!(
          {
            topics,
          },
          jest.fn(),
        );
      });

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toHaveBeenCalledWith(topics);
      });

      // Then
      expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalledTimes(0);
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });

    it("triggers re-subscription when preload topics change", async () => {
      // Given
      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        onSubscribe: () => mockUnsubscribe,
      });

      const props = setup({}, mockContext);
      const topics = [
        RenderStateBuilder.topic({ name: "/tf", schemaName: "tf2_msgs/TFMessage" }),
        RenderStateBuilder.topic({ name: "/other", schemaName: "std_msgs/String" }),
      ];
      const { rerender } = render(<ThreeDeeRender {...props} />);
      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!({ topics }, jest.fn());
      });

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toHaveBeenCalledWith(topics);
      });

      expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalledTimes(1);
      expect(mockUnsubscribe).not.toHaveBeenCalled();

      // When
      const newTopics = [
        ...topics,
        RenderStateBuilder.topic(
          RenderStateBuilder.topic({ name: "/new_topic", schemaName: "tf2_msgs/TFMessage" }),
        ),
      ];

      act(() => {
        mockContext.onRender!({ topics: newTopics }, jest.fn());
      });

      rerender(<ThreeDeeRender {...props} />);

      // Then
      // subscribeMessageRange was called 3 times:
      // 1 call for /tf, After adding /new_topic: 2 more calls (for both /tf and /new_topic)
      expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalledTimes(3);
      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it("does not trigger re-subscription when non-preload topics change", async () => {
      // Given
      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        onSubscribe: () => mockUnsubscribe,
      });

      const props = setup({}, mockContext);
      const topics = [
        RenderStateBuilder.topic({ name: "/tf", schemaName: "tf2_msgs/TFMessage" }),
        RenderStateBuilder.topic({ name: "/other", schemaName: "std_msgs/String" }),
      ];
      const { rerender } = render(<ThreeDeeRender {...props} />);
      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      // Set initial topics to trigger subscription
      act(() => {
        mockContext.onRender!({ topics }, jest.fn());
      });

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toHaveBeenCalledWith(topics);
      });

      expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalledTimes(1);
      expect(mockUnsubscribe).not.toHaveBeenCalled();

      // When
      // Add a non-preload topic (this shouldn't trigger the useLayoutEffect to re-run)
      const newTopics: Topic[] = [
        ...topics,
        RenderStateBuilder.topic(
          RenderStateBuilder.topic({ name: "/new_topic", schemaName: "std_msgs/String" }),
        ),
      ];

      act(() => {
        mockContext.onRender!({ topics: newTopics }, jest.fn());
      });

      rerender(<ThreeDeeRender {...props} />);

      // Then
      // subscribeMessageRange was not called again
      expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalledTimes(1);
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });

    describe("cleans up subscriptions", () => {
      it("on preload setting disabled", async () => {
        // Given
        const customRendererInstance = createMockRenderer({
          schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
        });

        jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

        const mockContext = createPreloadingContext({
          onSubscribe: () => mockUnsubscribe,
        });

        const props = setup({}, mockContext);
        const topics = [
          RenderStateBuilder.topic({ name: "/tf", schemaName: "tf2_msgs/TFMessage" }),
        ];
        render(<ThreeDeeRender {...props} />);
        await waitFor(() => {
          expect(customRendererInstance.setTopics).toBeDefined();
          expect(mockContext.onRender).toBeDefined();
        });

        act(() => {
          mockContext.onRender!({ topics }, jest.fn());
        });

        await waitFor(() => {
          expect(customRendererInstance.setTopics).toHaveBeenCalledWith(topics);
        });

        expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalledTimes(1);
        expect(mockUnsubscribe).not.toHaveBeenCalled();

        // When
        const newTopics = [RenderStateBuilder.topic({ schemaName: "std_msgs/String" })];

        act(() => {
          mockContext.onRender!({ topics: newTopics }, jest.fn());
        });

        // Then
        expect(mockUnsubscribe).toHaveBeenCalled();
      });

      it("on unmount", async () => {
        // Given
        const customRendererInstance = createMockRenderer({
          schemaSubscriptions: new Map([
            [
              "tf2_msgs/TFMessage",
              [
                {
                  preload: true,
                },
              ],
            ],
          ]),
        });

        jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

        const mockContext = createPreloadingContext({
          onSubscribe: () => mockUnsubscribe,
        });

        const props = setup({}, mockContext);
        const topics = [
          RenderStateBuilder.topic({ name: "/tf", schemaName: "tf2_msgs/TFMessage" }),
        ];
        const { unmount } = render(<ThreeDeeRender {...props} />);
        await waitFor(() => {
          expect(customRendererInstance.setTopics).toBeDefined();
          expect(mockContext.onRender).toBeDefined();
        });

        // When
        act(() => {
          mockContext.onRender!(
            {
              topics,
            },
            jest.fn(),
          );
        });

        await waitFor(() => {
          expect(customRendererInstance.setTopics).toHaveBeenCalledWith(topics);
        });

        expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalledTimes(1);
        expect(mockUnsubscribe).not.toHaveBeenCalled();

        // When
        unmount();

        // Then
        expect(mockUnsubscribe).toHaveBeenCalled();
      });
    });

    it("trims messages to MAX_TRANSFORM_MESSAGES and keeps oldest", async () => {
      // Given
      const topicName = "/tf";
      const totalMessages = MAX_TRANSFORM_MESSAGES + 5;
      const messages = buildTfMessages({
        topic: topicName,
        count: totalMessages,
      });

      const topics = [
        RenderStateBuilder.topic({ name: topicName, schemaName: "tf2_msgs/TFMessage" }),
      ];

      const mockBatchIterator = {
        async *[Symbol.asyncIterator]() {
          yield messages;
        },
      };

      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        onSubscribe: (args: any) => {
          void args.onNewRangeIterator?.(mockBatchIterator);
        },
      });

      const props = setup({}, mockContext);

      // When
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!(
          {
            topics,
            currentFrame: [],
            currentTime: { sec: 100, nsec: 0 },
          },
          jest.fn(),
        );
      });

      await waitFor(
        () => {
          expect(customRendererInstance.handleAllFramesMessages).toHaveBeenCalled();
          const handleAllFrames = customRendererInstance.handleAllFramesMessages.mock.calls;
          // Get the last call which should have the actual messages
          const lastCall = handleAllFrames[handleAllFrames.length - 1];
          const trimmedMessages = lastCall?.[0];
          expect(trimmedMessages).toBeDefined();
          expect(trimmedMessages.length).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );

      const handleAllFrames = customRendererInstance.handleAllFramesMessages.mock.calls;
      const lastCall = handleAllFrames[handleAllFrames.length - 1];
      const trimmedMessages = lastCall?.[0];

      // Then
      expect(trimmedMessages).toHaveLength(MAX_TRANSFORM_MESSAGES);

      // Verify the FIRST (oldest) messages were kept
      expect(trimmedMessages[0].receiveTime).toEqual({ sec: 100, nsec: 0 });
      expect(trimmedMessages[MAX_TRANSFORM_MESSAGES - 1].receiveTime).toEqual({
        sec: 100,
        nsec: MAX_TRANSFORM_MESSAGES - 1,
      });
    });

    it("respects custom maxPreloadMessages configuration", async () => {
      // Given
      const customMaxMessages = 10;
      const totalMessages = customMaxMessages + 5;
      const topicName = "/tf";
      const messages = buildTfMessages({
        topic: topicName,
        count: totalMessages,
      });

      const topics = [
        RenderStateBuilder.topic({ name: topicName, schemaName: "tf2_msgs/TFMessage" }),
      ];

      const mockBatchIterator = {
        async *[Symbol.asyncIterator]() {
          yield messages;
        },
      };

      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        initialState: {
          scene: {
            transforms: {
              enablePreloading: true,
              maxPreloadMessages: customMaxMessages,
            },
          },
          topics: {
            "/tf": { visible: true },
          },
        },
        onSubscribe: (args: any) => {
          void args.onNewRangeIterator?.(mockBatchIterator);
        },
      });

      const props = setup({}, mockContext);

      // When
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!(
          {
            topics,
            currentFrame: [],
            currentTime: { sec: 100, nsec: 0 },
          },
          jest.fn(),
        );
      });

      await waitFor(
        () => {
          expect(customRendererInstance.handleAllFramesMessages).toHaveBeenCalled();
          const handleAllFrames = customRendererInstance.handleAllFramesMessages.mock.calls;
          const lastCall = handleAllFrames[handleAllFrames.length - 1];
          const trimmedMessages = lastCall?.[0];
          expect(trimmedMessages).toBeDefined();
          expect(trimmedMessages.length).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );

      const handleAllFrames = customRendererInstance.handleAllFramesMessages.mock.calls;
      const lastCall = handleAllFrames[handleAllFrames.length - 1];
      const trimmedMessages = lastCall?.[0];

      // Then
      expect(trimmedMessages).toHaveLength(customMaxMessages);
    });

    it("updates loading indicator during progressive loading", async () => {
      // Given
      const topicName = "/tf";

      const messages1 = buildTfMessages({
        topic: topicName,
        count: 5,
      });

      const messages2 = buildTfMessages({
        topic: topicName,
        count: 5,
        startNsec: 100,
      });

      const topics = [
        RenderStateBuilder.topic({ name: topicName, schemaName: "tf2_msgs/TFMessage" }),
      ];

      const mockBatchIterator = {
        async *[Symbol.asyncIterator]() {
          yield messages1;
          await new Promise((resolve) => setTimeout(resolve, 60)); // Wait for debounce
          yield messages2;
        },
      };

      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        initialState: {
          scene: {
            transforms: { enablePreloading: true },
            enableStats: true, // Enable stats to show loading indicator
          },
          topics: {
            [topicName]: { visible: true },
          },
        },
        onSubscribe: (args: any) => {
          void args.onNewRangeIterator?.(mockBatchIterator);
        },
      });

      const props = setup({}, mockContext);

      // When
      const { container } = render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!(
          {
            topics,
            currentFrame: [],
            currentTime: { sec: 100, nsec: 0 },
          },
          jest.fn(),
        );
      });

      // Then - Loading indicator should appear
      await waitFor(
        () => {
          const loadingElement = container.querySelector('[class*="loadingTransforms"]');
          expect(loadingElement).toBeInTheDocument();
        },
        { timeout: 2000 },
      );
    });

    it("clears allFrames when clearPreloadBuffer event is emitted", async () => {
      // Given
      const topicName = "/tf";
      const messages = buildTfMessages({
        topic: topicName,
        count: 100,
      });

      const topics = [
        RenderStateBuilder.topic({ name: topicName, schemaName: "tf2_msgs/TFMessage" }),
      ];

      const mockBatchIterator = {
        async *[Symbol.asyncIterator]() {
          yield messages;
        },
      };

      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        onSubscribe: (args: any) => {
          void args.onNewRangeIterator?.(mockBatchIterator);
        },
      });

      const props = setup({}, mockContext);

      // When
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!(
          {
            topics,
            currentFrame: [],
            currentTime: { sec: 100, nsec: 0 },
          },
          jest.fn(),
        );
      });

      // Wait for initial load
      await waitFor(
        () => {
          expect(customRendererInstance.handleAllFramesMessages).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      // Reset the mock to track new calls
      customRendererInstance.handleAllFramesMessages.mockClear();
      (mockContext.unstable_subscribeMessageRange as jest.Mock).mockClear();

      // When - Emit clearPreloadBuffer event
      act(() => {
        customRendererInstance.emit("clearPreloadBuffer");
      });

      // Then - Should trigger reload
      await waitFor(
        () => {
          expect(mockContext.unstable_subscribeMessageRange).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );
    });

    it("does not show loading indicator when render stats is disabled", async () => {
      // Given
      const topicName = "/tf";
      const messages = buildTfMessages({
        topic: topicName,
        count: 100,
      });

      const topics = [
        RenderStateBuilder.topic({ name: topicName, schemaName: "tf2_msgs/TFMessage" }),
      ];

      const mockBatchIterator = {
        async *[Symbol.asyncIterator]() {
          yield messages;
        },
      };

      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        initialState: {
          scene: {
            transforms: {
              enablePreloading: true,
            },
            enableStats: false, // Stats disabled
          },
          topics: {
            [topicName]: { visible: true },
          },
        },
        onSubscribe: (args: any) => {
          void args.onNewRangeIterator?.(mockBatchIterator);
        },
      });

      const props = setup({}, mockContext);

      // When
      const { container } = render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!(
          {
            topics,
            currentFrame: [],
            currentTime: { sec: 100, nsec: 0 },
          },
          jest.fn(),
        );
      });

      // Wait for preloading to complete
      await waitFor(
        () => {
          expect(customRendererInstance.handleAllFramesMessages).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      // Then - Loading indicator should NOT appear (stats disabled)
      const loadingElement = container.querySelector('[class*="loadingTransforms"]');
      expect(loadingElement).not.toBeInTheDocument();
    });

    it("passes allFrames to handleSeek when seeking", async () => {
      // Given
      const topicName = "/tf";
      const messages = buildTfMessages({
        topic: topicName,
        count: 50,
      });

      const topics = [
        RenderStateBuilder.topic({ name: topicName, schemaName: "tf2_msgs/TFMessage" }),
      ];

      const mockBatchIterator = {
        async *[Symbol.asyncIterator]() {
          yield messages;
        },
      };

      const customRendererInstance = createMockRenderer({
        schemaSubscriptions: new Map([["tf2_msgs/TFMessage", [{ preload: true }]]]),
        currentTime: 0n,
      });

      jest.mocked(Renderer).mockImplementationOnce(() => customRendererInstance as any);

      const mockContext = createPreloadingContext({
        onSubscribe: (args: any) => {
          void args.onNewRangeIterator?.(mockBatchIterator);
        },
      });

      const props = setup({}, mockContext);

      // When
      render(<ThreeDeeRender {...props} />);

      await waitFor(() => {
        expect(customRendererInstance.setTopics).toBeDefined();
        expect(mockContext.onRender).toBeDefined();
      });

      act(() => {
        mockContext.onRender!(
          {
            topics,
            currentFrame: [],
            currentTime: { sec: 100, nsec: 0 },
          },
          jest.fn(),
        );
      });

      // Wait for initial load
      await waitFor(
        () => {
          expect(customRendererInstance.handleAllFramesMessages).toHaveBeenCalled();
        },
        { timeout: 2000 },
      );

      // When - Trigger seek
      act(() => {
        mockContext.onRender!(
          {
            topics,
            currentFrame: [],
            currentTime: { sec: 50, nsec: 0 },
            didSeek: true,
          },
          jest.fn(),
        );
      });

      // Then - handleSeek should be called with allFrames
      await waitFor(() => {
        expect(customRendererInstance.handleSeek).toHaveBeenCalledWith(
          expect.any(BigInt),
          expect.any(Array),
        );
        const seekCall = customRendererInstance.handleSeek.mock.calls[0];
        expect(seekCall?.[1]).toHaveLength(50);
      });
    });
  });
});
