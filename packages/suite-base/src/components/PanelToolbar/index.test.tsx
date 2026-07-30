/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import PanelContext from "@lichtblick/suite-base/components/PanelContext";
import { EmbeddedWorkspaceControlsContext } from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";
import { SharedRootContext } from "@lichtblick/suite-base/context/SharedRootContext";
import ThemeProvider from "@lichtblick/suite-base/theme/ThemeProvider";
import type { WorkspaceAppearance } from "@lichtblick/suite-base/types";

import PanelToolbar from ".";

jest.mock("@lichtblick/suite-base/providers/PanelStateContextProvider", () => ({
  useDefaultPanelTitle: () => ["Default panel"],
}));

jest.mock("@lichtblick/suite-base/components/PanelToolbar/PanelToolbarControls", () => ({
  PanelToolbarControls: ({
    additionalIcons,
    compact,
  }: {
    additionalIcons?: React.ReactNode;
    compact?: boolean;
  }) => (
    <div data-compact={String(compact)} data-testid="panel-toolbar-controls">
      {additionalIcons}
    </div>
  ),
}));

jest.mock("@lichtblick/suite-base/components/PanelToolbar/ToolbarIconButton", () => ({
  __esModule: true,
  default: ({
    children,
    title,
  }: React.PropsWithChildren<{
    title?: React.ReactNode;
  }>) => <button title={typeof title === "string" ? title : undefined}>{children}</button>,
}));

function renderToolbar(
  appearance: WorkspaceAppearance,
  toolbar: React.JSX.Element,
  options: { panelControlsVisible?: boolean } = {},
) {
  const { panelControlsVisible = false } = options;
  return render(
    <SharedRootContext.Provider
      value={{
        deepLinks: [],
        dataSources: [],
        extensionLoaders: [],
        workspaceAppearance: appearance,
      }}
    >
      <EmbeddedWorkspaceControlsContext.Provider
        value={{
          hidePanelControls: jest.fn(),
          panelControlsVisible,
          togglePanelControls: jest.fn(),
        }}
      >
        <ThemeProvider isDark={false}>{toolbar}</ThemeProvider>
      </EmbeddedWorkspaceControlsContext.Provider>
    </SharedRootContext.Provider>,
  );
}

describe("PanelToolbar workspace appearance", () => {
  it("keeps the standard full-row toolbar and title by default", () => {
    renderToolbar("standard", <PanelToolbar />);

    const toolbar = screen.getByTestId("mosaic-drag-handle");
    expect(toolbar).toHaveAttribute("data-workspace-appearance", "standard");
    expect(screen.getByText("Default panel")).toBeInTheDocument();
    expect(screen.getByTestId("panel-toolbar-controls")).toHaveAttribute("data-compact", "false");
    expect(getComputedStyle(toolbar).position).toBe("relative");
    expect(getComputedStyle(toolbar).width).toBe("100%");
    expect(toolbar).not.toHaveAttribute("data-xgc2-panel-controls");
    expect(toolbar).not.toHaveAttribute("aria-hidden");
    expect(toolbar).not.toHaveAttribute("role");
  });

  it("keeps embedded controls fully hidden until the host explicitly shows them", () => {
    renderToolbar("embedded", <PanelToolbar additionalIcons={<span>Additional action</span>} />);

    const toolbar = screen.getByTestId("mosaic-drag-handle");
    expect(toolbar).toHaveAttribute("data-workspace-appearance", "embedded");
    expect(toolbar).toHaveAttribute("data-xgc2-panel-controls");
    expect(toolbar).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("Default panel")).not.toBeInTheDocument();
    expect(screen.getByText("Additional action")).toBeInTheDocument();
    expect(screen.getByTitle("fullscreen")).toBeInTheDocument();
    expect(screen.getByTestId("panel-toolbar-controls")).toHaveAttribute("data-compact", "true");
    expect(getComputedStyle(toolbar).position).toBe("absolute");
    expect(getComputedStyle(toolbar).display).toBe("flex");
    expect(getComputedStyle(toolbar).width).toBe("max-content");
    expect(getComputedStyle(toolbar).visibility).toBe("hidden");
    expect(getComputedStyle(toolbar).pointerEvents).toBe("none");
  });

  it("shows embedded controls only when requested and isolates toolbar clicks", () => {
    const onPanelClick = jest.fn();
    renderToolbar(
      "embedded",
      <div onClick={onPanelClick}>
        <PanelToolbar />
      </div>,
      { panelControlsVisible: true },
    );

    const toolbar = screen.getByTestId("mosaic-drag-handle");
    expect(toolbar).not.toHaveAttribute("aria-hidden");
    expect(toolbar).toHaveAttribute("role", "toolbar");
    expect(toolbar).toHaveAttribute("aria-label", "Default panel controls");
    expect(getComputedStyle(toolbar).visibility).toBe("visible");
    expect(getComputedStyle(toolbar).pointerEvents).toBe("auto");

    fireEvent.click(toolbar);
    expect(onPanelClick).not.toHaveBeenCalled();
  });

  it("preserves business toolbar children in embedded appearance", () => {
    renderToolbar(
      "embedded",
      <PanelToolbar>
        <button>Panel-specific action</button>
      </PanelToolbar>,
      { panelControlsVisible: true },
    );

    const toolbar = screen.getByTestId("mosaic-drag-handle");
    expect(screen.getByRole("button", { name: "Panel-specific action" })).toBeInTheDocument();
    expect(screen.getByTestId("panel-toolbar-controls")).toBeInTheDocument();
    expect(getComputedStyle(toolbar).left).toBe("6px");
    expect(getComputedStyle(toolbar).right).toBe("6px");
    expect(getComputedStyle(toolbar).width).toBe("auto");
    expect(getComputedStyle(toolbar).maxWidth).toBe("none");
  });

  it("keeps the toolbar drag handle active in embedded appearance", () => {
    const connectToolbarDragHandle = jest.fn();

    renderToolbar(
      "embedded",
      <PanelContext.Provider value={{ connectToolbarDragHandle } as never}>
        <PanelToolbar />
      </PanelContext.Provider>,
    );

    expect(connectToolbarDragHandle).toHaveBeenCalledWith(screen.getByTestId("mosaic-drag-handle"));
  });
});
