/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, render, waitFor } from "@testing-library/react";

import {
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useEmbeddedWorkspaceControls } from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import { useWorkspaceStore } from "@lichtblick/suite-base/context/Workspace/WorkspaceContext";
import { useWorkspaceActions } from "@lichtblick/suite-base/context/Workspace/useWorkspaceActions";

import EmbeddedWorkspaceBridge, {
  EMBEDDED_3D_PANEL_ATTRIBUTE,
  EMBEDDED_NAVIGATION_EVENT,
  isEmbeddedNavigationCommand,
  isEmbeddedThemeCommand,
  isXgc2EmbeddedHostCommand,
  XGC2_EMBED_CHANNEL,
  XGC2_EMBED_SURFACES,
  XGC2_EMBED_VERSION,
  XGC2_HOST_VISIBILITY_EVENT,
  publishNavigationState,
  type Xgc2EmbeddedHostCommand,
} from "./EmbeddedWorkspaceBridge";

jest.mock("@lichtblick/suite-base/context/CurrentLayoutContext");
jest.mock("@lichtblick/suite-base/context/LayoutManagerContext");
jest.mock("@lichtblick/suite-base/context/Workspace/useWorkspaceActions");
jest.mock("@lichtblick/suite-base/context/Workspace/WorkspaceContext");
jest.mock("@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext");

/** The event stream of the desired view, driven by the test. */
class FakeEventSource {
  public static instances: FakeEventSource[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  public closed = false;
  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  public addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }
  public removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  public close(): void {
    this.closed = true;
  }
  public emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

const selectLeftItem = jest.fn();
const selectRightItem = jest.fn();
const hidePanelControls = jest.fn();
const togglePanelControls = jest.fn();
const toggleThreeDTools = jest.fn();
const toggleObstacleScene = jest.fn();
const setHostTheme = jest.fn();
const setSelectedLayoutId = jest.fn();
const getLayout = jest.fn();
let selectedLayoutId: string | undefined;

function mockControls(
  overrides: {
    panelControlsVisible?: boolean;
    threeDToolsVisible?: boolean;
    obstacleSceneVisible?: boolean;
  } = {},
) {
  return {
    embedded: true,
    hostTheme: undefined,
    setHostTheme,
    hidePanelControls,
    panelControlsVisible: false,
    threeDToolsVisible: false,
    obstacleSceneVisible: false,
    toggleObstacleScene,
    togglePanelControls,
    toggleThreeDTools,
    ...overrides,
  };
}

type MockSidebar = { open: boolean; item?: string; size?: number };

/** Runs the component's real selectors against a store holding only these sidebars. */
function mockSidebars(sidebars: { left: MockSidebar; right: MockSidebar }): void {
  jest.mocked(useWorkspaceStore).mockImplementation((selector) => selector({ sidebars } as never));
}

function hostCommand(surface: Xgc2EmbeddedHostCommand["surface"]): Xgc2EmbeddedHostCommand {
  return {
    channel: XGC2_EMBED_CHANNEL,
    version: XGC2_EMBED_VERSION,
    sender: "xgc2",
    type: "toggle-surface",
    surface,
  };
}

function dispatchHostMessage(data: unknown, overrides: Partial<MessageEventInit> = {}): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: window.location.origin,
      source: window.parent,
      ...overrides,
    }),
  );
}

describe("EmbeddedWorkspaceBridge", () => {
  beforeEach(() => {
    mockSidebars({ left: { open: false }, right: { open: false } });
    jest.mocked(useEmbeddedWorkspaceControls).mockReturnValue(mockControls());
    jest.mocked(useWorkspaceActions).mockReturnValue({
      sidebarActions: {
        left: { selectItem: selectLeftItem },
        right: { selectItem: selectRightItem },
      },
    } as never);
    selectedLayoutId = undefined;
    jest.mocked(useCurrentLayoutActions).mockReturnValue({ setSelectedLayoutId } as never);
    jest
      .mocked(useCurrentLayoutSelector)
      .mockImplementation((selector) =>
        selector({ selectedLayout: selectedLayoutId ? { id: selectedLayoutId } : undefined } as never),
      );
    jest.mocked(useLayoutManager).mockReturnValue({ getLayout } as never);
    FakeEventSource.instances = [];
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: FakeEventSource,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "EventSource");
    setSelectedLayoutId.mockReset();
    getLayout.mockReset();
    jest.restoreAllMocks();
    selectLeftItem.mockReset();
    selectRightItem.mockReset();
    hidePanelControls.mockReset();
    togglePanelControls.mockReset();
    toggleThreeDTools.mockReset();
    setHostTheme.mockReset();
  });

  it("accepts only the exact theme envelope from its authenticated parent", () => {
    const theme = {
      channel: XGC2_EMBED_CHANNEL,
      version: XGC2_EMBED_VERSION,
      sender: "xgc2",
      type: "theme",
      colorScheme: "dark",
      backgroundColor: "#161616",
    };
    expect(isEmbeddedThemeCommand(theme)).toBe(true);
    for (const changes of [
      { channel: "foreign" },
      { version: 1 },
      { sender: "lichtblick" },
      { type: "ready" },
      { colorScheme: "system" },
      { backgroundColor: "url(https://foreign.invalid)" },
      { backgroundColor: undefined },
      { extra: true },
    ]) {
      expect(isEmbeddedThemeCommand({ ...theme, ...changes })).toBe(false);
    }
    expect(isEmbeddedThemeCommand(null)).toBe(false);
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    const view = render(<EmbeddedWorkspaceBridge />);
    act(() => {
      dispatchHostMessage(theme, { source: null });
      dispatchHostMessage(theme, { origin: "https://foreign.invalid" });
      dispatchHostMessage({ ...theme, extra: true });
    });
    expect(setHostTheme).not.toHaveBeenCalled();
    act(() => {
      dispatchHostMessage(theme);
    });
    expect(setHostTheme).toHaveBeenCalledTimes(1);
    expect(setHostTheme).toHaveBeenCalledWith({
      colorScheme: "dark",
      backgroundColor: "#161616",
    });
    act(() => {
      dispatchHostMessage({ ...theme, colorScheme: "light", backgroundColor: "#ffffff" });
    });
    expect(setHostTheme).toHaveBeenLastCalledWith({
      colorScheme: "light",
      backgroundColor: "#ffffff",
    });
    view.unmount();
    setHostTheme.mockClear();
    act(() => {
      dispatchHostMessage(theme);
    });
    expect(setHostTheme).not.toHaveBeenCalled();
  });

  it("announces the exact versioned capabilities to its same-origin parent", () => {
    const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();

    render(<EmbeddedWorkspaceBridge />);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      {
        channel: XGC2_EMBED_CHANNEL,
        version: XGC2_EMBED_VERSION,
        sender: "lichtblick",
        type: "ready",
        capabilities: XGC2_EMBED_SURFACES,
        visibleSurfaces: [],
      },
      window.location.origin,
    );
  });

  it("addresses the parent origin declared by the embed URL", () => {
    const parentOrigin = "http://127.0.0.1:5174";
    window.history.pushState({}, "", `/?xgc2ParentOrigin=${encodeURIComponent(parentOrigin)}`);
    try {
      const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
      render(<EmbeddedWorkspaceBridge />);

      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "ready" }), parentOrigin);

      act(() => {
        dispatchHostMessage(hostCommand("topics"), { origin: parentOrigin });
      });
      expect(selectLeftItem).toHaveBeenCalledWith("topics");

      act(() => {
        dispatchHostMessage(hostCommand("layouts"));
      });
      expect(selectLeftItem).toHaveBeenCalledTimes(1);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("re-broadcasts host visibility as a window event", () => {
    render(<EmbeddedWorkspaceBridge />);
    const seen: boolean[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ visible: boolean }>).detail.visible);
    };
    window.addEventListener(XGC2_HOST_VISIBILITY_EVENT, listener);
    try {
      act(() => {
        dispatchHostMessage({
          channel: XGC2_EMBED_CHANNEL,
          version: XGC2_EMBED_VERSION,
          sender: "xgc2",
          type: "visibility",
          visible: false,
        });
      });
      act(() => {
        dispatchHostMessage({
          channel: XGC2_EMBED_CHANNEL,
          version: XGC2_EMBED_VERSION,
          sender: "xgc2",
          type: "visibility",
          visible: true,
        });
      });
      act(() => {
        dispatchHostMessage(
          {
            channel: XGC2_EMBED_CHANNEL,
            version: XGC2_EMBED_VERSION,
            sender: "xgc2",
            type: "visibility",
            visible: true,
          },
          { origin: "https://foreign.invalid" },
        );
      });
      expect(seen).toEqual([false, true]);
    } finally {
      window.removeEventListener(XGC2_HOST_VISIBILITY_EVENT, listener);
    }
  });

  it.each([
    "panel-settings",
    "alerts",
    "topics",
    "layouts",
  ] as const)("opens the %s left sidebar for a valid parent command", (surface) => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);

    act(() => {
      dispatchHostMessage(hostCommand(surface));
    });

    expect(selectLeftItem).toHaveBeenCalledWith(surface);
    expect(selectRightItem).not.toHaveBeenCalled();
    expect(hidePanelControls).not.toHaveBeenCalled();
    expect(togglePanelControls).not.toHaveBeenCalled();
    expect(toggleThreeDTools).not.toHaveBeenCalled();
  });

  it("opens the variables right sidebar for a valid parent command", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);

    act(() => {
      dispatchHostMessage(hostCommand("variables"));
    });

    expect(selectRightItem).toHaveBeenCalledWith("variables");
    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(hidePanelControls).not.toHaveBeenCalled();
    expect(togglePanelControls).not.toHaveBeenCalled();
    expect(toggleThreeDTools).not.toHaveBeenCalled();
  });

  it("toggles pane controls only for the panel-controls capability", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);

    act(() => {
      dispatchHostMessage(hostCommand("panel-controls"));
    });

    expect(togglePanelControls).toHaveBeenCalledTimes(1);
    expect(hidePanelControls).not.toHaveBeenCalled();
    expect(toggleThreeDTools).not.toHaveBeenCalled();
    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(selectRightItem).not.toHaveBeenCalled();
  });

  it("toggles overlay 3D tools through the host 3d-tools surface", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);

    act(() => {
      dispatchHostMessage(hostCommand("3d-tools"));
    });

    expect(toggleThreeDTools).toHaveBeenCalledTimes(1);
    expect(togglePanelControls).not.toHaveBeenCalled();
    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(selectRightItem).not.toHaveBeenCalled();
  });

  it("reports independent visible surfaces and toggles an open sidebar closed", () => {
    mockSidebars({
      left: { open: true, item: "topics" },
      right: { open: true, item: "variables" },
    });
    jest
      .mocked(useEmbeddedWorkspaceControls)
      .mockReturnValue(mockControls({ panelControlsVisible: true, threeDToolsVisible: true }));
    const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleSurfaces: ["3d-tools", "topics", "variables", "panel-controls"],
      }),
      window.location.origin,
    );
    act(() => {
      dispatchHostMessage(hostCommand("topics"));
    });
    expect(selectLeftItem).toHaveBeenCalledWith(undefined);
  });

  it("closes the visible variables sidebar without changing left or panel controls", () => {
    mockSidebars({
      left: { open: true, item: "topics" },
      right: { open: true, item: "variables" },
    });
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);
    act(() => {
      dispatchHostMessage(hostCommand("variables"));
    });
    expect(selectRightItem).toHaveBeenCalledWith(undefined);
    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(hidePanelControls).not.toHaveBeenCalled();
    expect(togglePanelControls).not.toHaveBeenCalled();
  });

  it("reports current surfaces after local sidebar and panel-control state changes", () => {
    const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
    const { rerender } = render(<EmbeddedWorkspaceBridge />);
    mockSidebars({
      left: { open: true, item: "layouts" },
      right: { open: true, item: "variables" },
    });
    jest
      .mocked(useEmbeddedWorkspaceControls)
      .mockReturnValue(mockControls({ panelControlsVisible: true }));
    rerender(<EmbeddedWorkspaceBridge />);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        version: 2,
        visibleSurfaces: ["layouts", "variables", "panel-controls"],
      }),
      window.location.origin,
    );
    mockSidebars({
      left: { open: false, item: "layouts" },
      right: { open: true, item: "variables" },
    });
    rerender(<EmbeddedWorkspaceBridge />);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        visibleSurfaces: ["variables", "panel-controls"],
      }),
      window.location.origin,
    );
    act(() => {
      dispatchHostMessage(hostCommand("layouts"));
    });
    expect(selectLeftItem).toHaveBeenCalledTimes(1);
    expect(selectLeftItem).toHaveBeenCalledWith("layouts");
  });

  it("does not re-announce when only a sidebar size changes", () => {
    const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
    mockSidebars({ left: { open: true, item: "layouts", size: 20 }, right: { open: false } });
    const { rerender } = render(<EmbeddedWorkspaceBridge />);
    expect(postMessage).toHaveBeenCalledTimes(1);

    for (const size of [21, 22, 23]) {
      mockSidebars({ left: { open: true, item: "layouts", size }, right: { open: false, size } });
      rerender(<EmbeddedWorkspaceBridge />);
    }

    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects commands from a different origin or window", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);

    act(() => {
      dispatchHostMessage(hostCommand("topics"), { origin: "https://example.invalid" });
      dispatchHostMessage(hostCommand("topics"), { source: null });
    });

    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(selectRightItem).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    "toggle-surface",
    {},
    { ...hostCommand("topics"), channel: "other" },
    { ...hostCommand("topics"), version: 1 },
    { ...hostCommand("topics"), sender: "lichtblick" },
    { ...hostCommand("topics"), type: "close-surface" },
    { ...hostCommand("topics"), surface: "extensions" },
    { ...hostCommand("topics"), unexpected: true },
  ])("rejects a malformed or non-whitelisted host message: %p", (message) => {
    expect(isXgc2EmbeddedHostCommand(message)).toBe(false);
  });

  it("routes authenticated navigation only to the named native 3D panel", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);
    const a = document.createElement("div"),
      b = document.createElement("div");
    a.setAttribute("data-xgc-native-3d-panel-id", "ThreeDeeRender!a");
    b.setAttribute("data-xgc-native-3d-panel-id", "ThreeDeeRender!b");
    document.body.append(a, b);
    const first = jest.fn(),
      second = jest.fn();
    a.addEventListener(EMBEDDED_NAVIGATION_EVENT, first);
    b.addEventListener(EMBEDDED_NAVIGATION_EVENT, second);
    const message = {
      channel: XGC2_EMBED_CHANNEL,
      version: XGC2_EMBED_VERSION,
      sender: "xgc2",
      type: "navigation",
      panelId: "ThreeDeeRender!b",
      action: "goal",
    };
    expect(isEmbeddedNavigationCommand(message)).toBe(true);
    act(() => {
      dispatchHostMessage(message, { origin: "https://wrong.invalid" });
    });
    expect(second).not.toHaveBeenCalled();
    act(() => {
      dispatchHostMessage(message);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    act(() => {
      dispatchHostMessage({ ...message, action: "perspective" });
    });
    expect(second).toHaveBeenCalledTimes(2);
    expect(first).not.toHaveBeenCalled();
    expect(isEmbeddedNavigationCommand({ ...message, frameId: "extra" })).toBe(false);
    expect(isEmbeddedNavigationCommand({ ...message, action: "follow" })).toBe(false);
    a.remove();
    b.remove();
  });

  it("removes its message listener when unmounted", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    const { unmount } = render(<EmbeddedWorkspaceBridge />);
    unmount();

    act(() => {
      dispatchHostMessage(hostCommand("alerts"));
    });

    expect(selectLeftItem).not.toHaveBeenCalled();
  });

  it.each([
    "follow",
    "follow-pose",
  ])("authenticates and dispatches the exact %s command to its native panel", (action) => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);
    const panel = document.createElement("div");
    panel.setAttribute("data-xgc-native-3d-panel-id", "ThreeDeeRender!follow");
    document.body.append(panel);
    const receive = jest.fn();
    panel.addEventListener(EMBEDDED_NAVIGATION_EVENT, receive);
    const message = {
      channel: XGC2_EMBED_CHANNEL,
      version: XGC2_EMBED_VERSION,
      sender: "xgc2",
      type: "navigation",
      panelId: "ThreeDeeRender!follow",
      action,
      frameId: "robot/base_link",
    };
    expect(isEmbeddedNavigationCommand(message)).toBe(true);
    for (const changes of [
      { channel: "foreign" },
      { version: 1 },
      { sender: "lichtblick" },
      { frameId: undefined },
      { frameId: "" },
      { frameId: 5 },
      { action: "follow-unknown" },
      { followMode: "follow-pose" },
      { extra: true },
    ]) {
      expect(isEmbeddedNavigationCommand({ ...message, ...changes })).toBe(false);
    }
    act(() => {
      dispatchHostMessage(message, { source: null });
      dispatchHostMessage(message, { origin: "https://foreign.invalid" });
      dispatchHostMessage({ ...message, panelId: "ThreeDeeRender!elsewhere" });
      dispatchHostMessage({ ...message, frameId: "" });
    });
    expect(receive).not.toHaveBeenCalled();
    act(() => {
      dispatchHostMessage(message);
    });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]![0].detail).toEqual(message);
    panel.remove();
  });
});

describe("EmbeddedWorkspaceBridge desired view", () => {
  const PANEL_ID = "ThreeDeeRender!view";
  let panel: HTMLElement;
  type Command = { action: string; frameId?: string; panelId: string };
  let commands: Command[];

  function emitView(revision: string, view: Record<string, unknown>) {
    act(() => {
      FakeEventSource.instances[0]!.emit("view", { revision, view });
    });
  }

  /** What the native 3D panel publishes about its navigation. */
  function reportPanel(state: { available?: boolean; perspective?: boolean; followFrameId?: string }) {
    act(() => {
      publishNavigationState({
        channel: XGC2_EMBED_CHANNEL,
        version: XGC2_EMBED_VERSION,
        sender: "lichtblick",
        type: "navigation-state",
        panelId: PANEL_ID,
        available: state.available ?? true,
        perspective: state.perspective ?? false,
        canGoal: false,
        goalActive: false,
        followFrameId: state.followFrameId,
      });
    });
  }

  beforeEach(() => {
    mockSidebars({ left: { open: false }, right: { open: false } });
    jest.mocked(useEmbeddedWorkspaceControls).mockReturnValue(mockControls());
    jest.mocked(useWorkspaceActions).mockReturnValue({
      sidebarActions: {
        left: { selectItem: selectLeftItem },
        right: { selectItem: selectRightItem },
      },
    } as never);
    selectedLayoutId = undefined;
    jest.mocked(useCurrentLayoutActions).mockReturnValue({ setSelectedLayoutId } as never);
    jest
      .mocked(useCurrentLayoutSelector)
      .mockImplementation((selector) =>
        selector({ selectedLayout: selectedLayoutId ? { id: selectedLayoutId } : undefined } as never),
      );
    jest.mocked(useLayoutManager).mockReturnValue({ getLayout } as never);
    getLayout.mockResolvedValue({ id: "camera-ar" });
    FakeEventSource.instances = [];
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: FakeEventSource,
    });
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    panel = document.createElement("div");
    panel.setAttribute(EMBEDDED_3D_PANEL_ATTRIBUTE, PANEL_ID);
    document.body.append(panel);
    commands = [];
    panel.addEventListener(EMBEDDED_NAVIGATION_EVENT, (event) => {
      commands.push((event as CustomEvent<Command>).detail);
    });
  });

  afterEach(() => {
    panel.remove();
    Reflect.deleteProperty(globalThis, "EventSource");
    setSelectedLayoutId.mockReset();
    getLayout.mockReset();
    selectLeftItem.mockReset();
    selectRightItem.mockReset();
    toggleThreeDTools.mockReset();
    jest.restoreAllMocks();
  });

  it("follows the stream of this origin for as long as the bridge is mounted", () => {
    const { unmount } = render(<EmbeddedWorkspaceBridge />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe(
      new URL("xgc2/view/events", document.baseURI).href,
    );
    unmount();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
  });

  it("selects the layout, shows the surfaces and steers the panel once the layout is shown", async () => {
    const view = render(<EmbeddedWorkspaceBridge />);
    reportPanel({ perspective: false });
    emitView("3", {
      layoutId: "camera-ar",
      followRobot: "uav1",
      perspective: true,
      visibleSurfaces: ["topics", "3d-tools"],
    });
    await waitFor(() => {
      expect(setSelectedLayoutId).toHaveBeenCalledWith("camera-ar");
    });
    expect(selectLeftItem).toHaveBeenCalledWith("topics");
    expect(toggleThreeDTools).toHaveBeenCalledTimes(1);
    // The panel shown belongs to the layout that is being replaced.
    expect(commands).toEqual([]);

    selectedLayoutId = "camera-ar";
    act(() => {
      view.rerender(<EmbeddedWorkspaceBridge />);
    });
    expect(commands).toEqual([
      expect.objectContaining({
        panelId: PANEL_ID,
        action: "follow",
        frameId: "xgc/robots/uav1/base_link",
      }),
      expect.objectContaining({ panelId: PANEL_ID, action: "perspective" }),
    ]);

    // The panel reports the new camera; the operator then changes it and is left alone.
    reportPanel({ perspective: true, followFrameId: "xgc/robots/uav1/base_link" });
    reportPanel({ perspective: false, followFrameId: "xgc/robots/uav1/base_link" });
    expect(commands).toHaveLength(2);
    expect(setSelectedLayoutId).toHaveBeenCalledTimes(1);
    expect(toggleThreeDTools).toHaveBeenCalledTimes(1);

    // The same revision is not applied again, a new revision is.
    emitView("3", { perspective: true });
    expect(commands).toHaveLength(2);
    emitView("4", { perspective: true });
    expect(commands).toHaveLength(3);
    expect(commands[2]).toEqual(expect.objectContaining({ action: "perspective" }));
  });

  it("waits for the panel and applies the camera to the first one that appears", () => {
    render(<EmbeddedWorkspaceBridge />);
    emitView("1", { followRobot: "ugv2" });
    expect(commands).toEqual([]);
    reportPanel({ available: false });
    expect(commands).toEqual([]);
    reportPanel({ available: true });
    expect(commands).toEqual([
      expect.objectContaining({ action: "follow", frameId: "xgc/robots/ugv2/base_link" }),
    ]);
  });

  it("does not steer when no panel, or more than one, can be navigated", () => {
    render(<EmbeddedWorkspaceBridge />);
    emitView("1", { perspective: true });
    act(() => {
      for (const panelId of [PANEL_ID, "ThreeDeeRender!other"]) {
        publishNavigationState({
          channel: XGC2_EMBED_CHANNEL,
          version: XGC2_EMBED_VERSION,
          sender: "lichtblick",
          type: "navigation-state",
          panelId,
          available: true,
          perspective: false,
          canGoal: false,
          goalActive: false,
          followFrameId: undefined,
        });
      }
    });
    expect(commands).toEqual([]);
  });

  it("applies the rest of the view when the layout does not exist", async () => {
    getLayout.mockResolvedValue(undefined);
    render(<EmbeddedWorkspaceBridge />);
    reportPanel({ perspective: true });
    emitView("2", { layoutId: "gone", followRobot: "uav1" });
    await waitFor(() => {
      expect(commands).toEqual([
        expect.objectContaining({ action: "follow", frameId: "xgc/robots/uav1/base_link" }),
      ]);
    });
    expect(setSelectedLayoutId).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("does not exist: gone"));
    (console.warn as jest.Mock).mockClear();
  });

  it("leaves the page alone for a view it cannot read and for fields it does not state", () => {
    render(<EmbeddedWorkspaceBridge />);
    reportPanel({ perspective: false });
    act(() => {
      FakeEventSource.instances[0]!.emit("view", { revision: "1", view: { unknown: 1 } });
    });
    emitView("2", {});
    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(setSelectedLayoutId).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    (console.warn as jest.Mock).mockClear();
  });
});
