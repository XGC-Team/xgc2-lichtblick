/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  EMBEDDED_PANEL_CONTROLS_ATTRIBUTE,
  EmbeddedWorkspaceControlsProvider,
  useEmbeddedWorkspaceControls,
} from "./EmbeddedWorkspaceControlsContext";

function ControlsHarness(): React.JSX.Element {
  const { hidePanelControls, panelControlsVisible, togglePanelControls } =
    useEmbeddedWorkspaceControls();

  return (
    <>
      <output data-testid="visibility">{String(panelControlsVisible)}</output>
      <button onClick={togglePanelControls}>Toggle</button>
      <button onClick={hidePanelControls}>Hide</button>
      <div {...{ [EMBEDDED_PANEL_CONTROLS_ATTRIBUTE]: "" }} data-testid="inside-toolbar" />
      <div data-testid="outside-toolbar" />
    </>
  );
}

function renderProvider() {
  return render(
    <EmbeddedWorkspaceControlsProvider>
      <ControlsHarness />
    </EmbeddedWorkspaceControlsProvider>,
  );
}

describe("EmbeddedWorkspaceControlsProvider", () => {
  it("starts hidden, toggles explicitly, and ignores clicks inside a pane toolbar", () => {
    renderProvider();

    expect(screen.getByTestId("visibility")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    expect(screen.getByTestId("visibility")).toHaveTextContent("true");

    fireEvent.click(screen.getByTestId("inside-toolbar"));
    expect(screen.getByTestId("visibility")).toHaveTextContent("true");
  });

  it("hides visible controls after a click outside or Escape", () => {
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    fireEvent.click(screen.getByTestId("outside-toolbar"));
    expect(screen.getByTestId("visibility")).toHaveTextContent("false");

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("visibility")).toHaveTextContent("false");
  });

  it("supports an explicit hide action", () => {
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));

    expect(screen.getByTestId("visibility")).toHaveTextContent("false");
  });
});
