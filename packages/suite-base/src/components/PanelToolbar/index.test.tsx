/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import PanelContext from "@lichtblick/suite-base/components/PanelContext";
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

function renderToolbar(appearance: WorkspaceAppearance, toolbar: React.JSX.Element) {
  return render(
    <SharedRootContext.Provider
      value={{
        deepLinks: [],
        dataSources: [],
        extensionLoaders: [],
        workspaceAppearance: appearance,
      }}
    >
      <ThemeProvider isDark={false}>{toolbar}</ThemeProvider>
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
  });

  it("renders embedded controls as a compact overlay without a title row", () => {
    renderToolbar("embedded", <PanelToolbar additionalIcons={<span>Additional action</span>} />);

    const toolbar = screen.getByTestId("mosaic-drag-handle");
    expect(toolbar).toHaveAttribute("data-workspace-appearance", "embedded");
    expect(screen.queryByText("Default panel")).not.toBeInTheDocument();
    expect(screen.getByText("Additional action")).toBeInTheDocument();
    expect(screen.getByTitle("fullscreen")).toBeInTheDocument();
    expect(screen.getByTestId("panel-toolbar-controls")).toHaveAttribute("data-compact", "true");
    expect(getComputedStyle(toolbar).position).toBe("absolute");
    expect(getComputedStyle(toolbar).display).toBe("flex");
    expect(getComputedStyle(toolbar).width).toBe("max-content");
  });

  it("preserves business toolbar children in embedded appearance", () => {
    renderToolbar(
      "embedded",
      <PanelToolbar>
        <button>Panel-specific action</button>
      </PanelToolbar>,
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
