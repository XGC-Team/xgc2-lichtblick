/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";

import {
  EmbeddedWorkspaceControlsProvider,
  useEmbeddedWorkspaceControls,
} from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";
import { createSyncRoot } from "@lichtblick/suite-base/panels/createSyncRoot";

import {
  ForwardEmbeddedWorkspaceControls,
  useForwardEmbeddedWorkspaceControls,
} from "./ForwardEmbeddedWorkspaceControls";

it("forwards toggles into an independent panel root without recreating its canvas", async () => {
  const panel = document.createElement("div");
  document.body.appendChild(panel);
  const mount = jest.fn();
  const unmount = jest.fn();
  function Overlay(): React.JSX.Element {
    const { threeDToolsVisible } = useEmbeddedWorkspaceControls();
    useEffect(() => {
      mount();
      return unmount;
    }, []);
    return (
      <>
        <canvas data-testid="scene" />
        <div data-testid="tools" hidden={!threeDToolsVisible} />
      </>
    );
  }
  function Host(): React.JSX.Element {
    const store = useForwardEmbeddedWorkspaceControls();
    const { toggleThreeDTools } = useEmbeddedWorkspaceControls();
    useEffect(
      () =>
        createSyncRoot(
          <ForwardEmbeddedWorkspaceControls store={store}>
            <Overlay />
          </ForwardEmbeddedWorkspaceControls>,
          panel,
        ),
      [store],
    );
    return <button onClick={toggleThreeDTools}>Toggle tools</button>;
  }
  const host = render(
    <EmbeddedWorkspaceControlsProvider>
      <Host />
    </EmbeddedWorkspaceControlsProvider>,
  );
  const canvas = await screen.findByTestId("scene");
  expect(screen.getByTestId("tools")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
  expect(screen.getByTestId("tools")).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Toggle tools" }));
  expect(screen.getByTestId("tools")).toBeVisible();
  expect(screen.getByTestId("scene")).toBe(canvas);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
  host.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(unmount).toHaveBeenCalledTimes(1);
});
