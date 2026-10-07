/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { act, render } from "@testing-library/react";

import { subscribeEmbeddedParkedState } from "@lichtblick/suite-base/components/EmbeddedParkedSignal";
import { XGC2_HOST_VISIBILITY_EVENT } from "@lichtblick/suite-base/components/EmbeddedWorkspaceBridge";
import { BuiltinPanelExtensionContext } from "@lichtblick/suite-base/components/PanelExtensionAdapter";
import { useAnalytics } from "@lichtblick/suite-base/context/AnalyticsContext";
import { EmbeddedWorkspaceControlsProvider } from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";

import { Renderer } from "./Renderer";
import type { RendererOverlay } from "./RendererOverlay";
import { ThreeDeeRender } from "./ThreeDeeRender";
import type { ThreeDeeRenderProps } from "./types";

jest.mock("./ModelCache", () => ({
  ModelCache: jest.fn(),
}));

jest.mock("./SceneExtensionConfig", () => ({
  DEFAULT_SCENE_EXTENSION_CONFIG: {},
}));

jest.mock("@lichtblick/suite-base/context/AnalyticsContext", () => ({
  useAnalytics: jest.fn(),
}));

const createMockRenderer = () => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
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
    setCanvasVisibility: jest.fn(),
    animationFrame: jest.fn(),
    queueThrottledAnimationFrame: jest.fn(),
    addListener: jest.fn((event: string, listener: (...args: any[]) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(listener);
    }),
    removeListener: jest.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
    }),
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
};

jest.mock("./Renderer", () => ({
  Renderer: jest.fn().mockImplementation(() => createMockRenderer()),
}));

jest.mock("@lichtblick/suite-base/theme/ThemeProvider", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("./RendererOverlay", () => ({
  RendererOverlay: (_props: React.ComponentProps<typeof RendererOverlay>) => (
    <div data-testid="renderer-overlay">Renderer Overlay</div>
  ),
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

describe("ThreeDeeRender parked signal gating", () => {
  const mockAnalytics = { logEvent: jest.fn() };
  const mockedRenderer = jest.mocked(Renderer);

  const setup = (): ThreeDeeRenderProps => ({
    context: createMockContext(),
    interfaceMode: "3d",
    testOptions: {},
    customCameraModels: new Map(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (useAnalytics as jest.Mock).mockReturnValue(mockAnalytics);

    HTMLCanvasElement.prototype.getContext = jest.fn().mockReturnValue({
      canvas: document.createElement("canvas"),
      drawArrays: jest.fn(),
      clearColor: jest.fn(),
      clear: jest.fn(),
      viewport: jest.fn(),
    });
  });

  it("standalone: a hidden canvas stops drawing but never parks message processing", () => {
    const parkedStates: boolean[] = [];
    const unsubscribe = subscribeEmbeddedParkedState((parked) => parkedStates.push(parked));
    const view = render(<ThreeDeeRender {...setup()} />);
    const renderer = mockedRenderer.mock.results[0]!.value;

    act(() => {
      window.dispatchEvent(
        new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: false } }),
      );
    });

    // Drawing-stop semantics are unchanged in standalone sessions...
    expect(renderer.setCanvasVisibility).toHaveBeenCalledWith("hidden");
    // ...but the parked signal must stay silent: no canvas registered, so
    // Plot and other history consumers keep receiving messages.
    expect(parkedStates).toEqual([false]);

    view.unmount();
    unsubscribe();
    expect(parkedStates).toEqual([false]);
  });

  it("embedded: a host-hidden canvas parks and re-showing resumes message processing", () => {
    const parkedStates: boolean[] = [];
    const unsubscribe = subscribeEmbeddedParkedState((parked) => parkedStates.push(parked));
    const view = render(
      <EmbeddedWorkspaceControlsProvider embedded>
        <ThreeDeeRender {...setup()} />
      </EmbeddedWorkspaceControlsProvider>,
    );
    const renderer = mockedRenderer.mock.results[0]!.value;

    act(() => {
      window.dispatchEvent(
        new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: false } }),
      );
    });
    expect(renderer.setCanvasVisibility).toHaveBeenCalledWith("hidden");
    expect(parkedStates).toEqual([false, true]);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: true } }),
      );
    });
    expect(renderer.setCanvasVisibility).toHaveBeenCalledWith("visible");
    expect(parkedStates).toEqual([false, true, false]);

    view.unmount();
    unsubscribe();
    expect(parkedStates).toEqual([false, true, false]);
  });
});
