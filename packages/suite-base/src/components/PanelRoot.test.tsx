/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { APP_BAR_HEIGHT } from "@lichtblick/suite-base/components/AppBar/constants";
import { PanelRoot } from "@lichtblick/suite-base/components/PanelRoot";
import { SharedRootContext } from "@lichtblick/suite-base/context/SharedRootContext";
import ThemeProvider from "@lichtblick/suite-base/theme/ThemeProvider";
import type { WorkspaceAppearance } from "@lichtblick/suite-base/types";

function renderFullscreenPanel(appearance: WorkspaceAppearance) {
  return render(
    <SharedRootContext.Provider
      value={{
        deepLinks: [],
        dataSources: [],
        extensionLoaders: [],
        workspaceAppearance: appearance,
      }}
    >
      <ThemeProvider isDark={false}>
        <PanelRoot
          data-testid="panel-root"
          fullscreenState="entered"
          hasFullscreenDescendant={false}
          selected={false}
          sourceRect={undefined}
        />
      </ThemeProvider>
    </SharedRootContext.Provider>,
  );
}

describe("PanelRoot fullscreen workspace offset", () => {
  it("keeps the app bar offset in standard appearance", () => {
    renderFullscreenPanel("standard");

    const panelRoot = screen.getByTestId("panel-root");
    expect(panelRoot).toHaveAttribute("data-workspace-appearance", "standard");
    expect(getComputedStyle(panelRoot).top).toBe(`${APP_BAR_HEIGHT}px`);
  });

  it("uses the full viewport in embedded appearance", () => {
    renderFullscreenPanel("embedded");

    const panelRoot = screen.getByTestId("panel-root");
    expect(panelRoot).toHaveAttribute("data-workspace-appearance", "embedded");
    expect(getComputedStyle(panelRoot).top).toBe("0px");
  });
});
