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
  const {
    hidePanelControls,
    panelControlsVisible,
    threeDToolsVisible,
    togglePanelControls,
    toggleThreeDTools,
  } = useEmbeddedWorkspaceControls();

  return (
    <>
      <output data-testid="visibility">{String(panelControlsVisible)}</output>
      <output data-testid="three-d-tools">{String(threeDToolsVisible)}</output>
      <button onClick={togglePanelControls}>Toggle</button>
      <button onClick={toggleThreeDTools}>Toggle 3D tools</button>
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
  it("starts embedded tools hidden and still allows explicit toggles", () => {
    render(<EmbeddedWorkspaceControlsProvider defaultThreeDToolsVisible={false}>
      <ControlsHarness />
    </EmbeddedWorkspaceControlsProvider>);
    expect(screen.getByTestId("three-d-tools")).toHaveTextContent("false");
    expect(screen.getByTestId("visibility")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D tools" }));
    expect(screen.getByTestId("three-d-tools")).toHaveTextContent("true");
  });

  it("shows overlay 3D tools by default and toggles them independently of pane controls", () => {
    renderProvider();

    expect(screen.getByTestId("three-d-tools")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D tools" }));
    expect(screen.getByTestId("three-d-tools")).toHaveTextContent("false");
    expect(screen.getByTestId("visibility")).toHaveTextContent("false");
  });

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
