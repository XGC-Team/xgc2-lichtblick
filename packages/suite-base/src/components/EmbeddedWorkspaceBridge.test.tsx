/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, render } from "@testing-library/react";

import { useEmbeddedWorkspaceControls } from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";
import { useWorkspaceActions } from "@lichtblick/suite-base/context/Workspace/useWorkspaceActions";

import EmbeddedWorkspaceBridge, {
  isXgc2EmbeddedHostCommand,
  XGC2_EMBED_CHANNEL,
  XGC2_EMBED_SURFACES,
  XGC2_EMBED_VERSION,
  type Xgc2EmbeddedHostCommand,
} from "./EmbeddedWorkspaceBridge";

jest.mock("@lichtblick/suite-base/context/Workspace/useWorkspaceActions");
jest.mock("@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext");

const selectLeftItem = jest.fn();
const selectRightItem = jest.fn();
const hidePanelControls = jest.fn();
const togglePanelControls = jest.fn();

function hostCommand(surface: Xgc2EmbeddedHostCommand["surface"]): Xgc2EmbeddedHostCommand {
  return {
    channel: XGC2_EMBED_CHANNEL,
    version: XGC2_EMBED_VERSION,
    sender: "xgc2",
    type: "open-surface",
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
    jest.mocked(useEmbeddedWorkspaceControls).mockReturnValue({
      hidePanelControls,
      panelControlsVisible: false,
      togglePanelControls,
    });
    jest.mocked(useWorkspaceActions).mockReturnValue({
      sidebarActions: {
        left: { selectItem: selectLeftItem },
        right: { selectItem: selectRightItem },
      },
    } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    selectLeftItem.mockReset();
    selectRightItem.mockReset();
    hidePanelControls.mockReset();
    togglePanelControls.mockReset();
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
      },
      window.location.origin,
    );
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
    expect(hidePanelControls).toHaveBeenCalledTimes(1);
    expect(togglePanelControls).not.toHaveBeenCalled();
  });

  it("opens the variables right sidebar for a valid parent command", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);

    act(() => {
      dispatchHostMessage(hostCommand("variables"));
    });

    expect(selectRightItem).toHaveBeenCalledWith("variables");
    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(hidePanelControls).toHaveBeenCalledTimes(1);
    expect(togglePanelControls).not.toHaveBeenCalled();
  });

  it("toggles pane controls only for the panel-controls capability", () => {
    jest.spyOn(window.parent, "postMessage").mockImplementation();
    render(<EmbeddedWorkspaceBridge />);

    act(() => {
      dispatchHostMessage(hostCommand("panel-controls"));
    });

    expect(togglePanelControls).toHaveBeenCalledTimes(1);
    expect(hidePanelControls).not.toHaveBeenCalled();
    expect(selectLeftItem).not.toHaveBeenCalled();
    expect(selectRightItem).not.toHaveBeenCalled();
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
    "open-surface",
    {},
    { ...hostCommand("topics"), channel: "other" },
    { ...hostCommand("topics"), version: 2 },
    { ...hostCommand("topics"), sender: "lichtblick" },
    { ...hostCommand("topics"), type: "close-surface" },
    { ...hostCommand("topics"), surface: "extensions" },
    { ...hostCommand("topics"), unexpected: true },
  ])("rejects a malformed or non-whitelisted host message: %p", (message) => {
    expect(isXgc2EmbeddedHostCommand(message)).toBe(false);
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
});
