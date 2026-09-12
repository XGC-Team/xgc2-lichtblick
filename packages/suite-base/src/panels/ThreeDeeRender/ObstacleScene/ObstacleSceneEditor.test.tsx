/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import "@testing-library/jest-dom";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as THREE from "three";

import { embeddedSceneBridge } from "@lichtblick/suite-base/components/EmbeddedSceneBridge";
import {
  EmbeddedWorkspaceControlsProvider,
  useEmbeddedWorkspaceControls,
} from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";

import { ObstacleSceneEditor } from "./ObstacleSceneEditor";
import { ObstacleSceneExtension } from "./ObstacleSceneExtension";
import { createObstacle, SCENE_DRAFT_ID } from "./geometry";
import type { SceneEnvelope } from "./types";
import type { IRenderer } from "../IRenderer";
import { RendererContext } from "../RendererContext";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" } }),
}));

function SceneTools() {
  const { toggleObstacleScene } = useEmbeddedWorkspaceControls();
  return <button onClick={toggleObstacleScene}>Obstacle scene</button>;
}

function setup() {
  const canvas = document.createElement("canvas");
  const renderer = {
    gl: { domElement: canvas },
    settings: { setNodesForKey: jest.fn() },
    config: { scene: { obstacleScene: { namespace: "/xgc/scene" } } },
    queueAnimationFrame: jest.fn(),
    cameraHandler: {
      getActiveCamera: () => new THREE.PerspectiveCamera(),
      setInteractionEnabled: jest.fn(),
    },
    addCoordinateFrame: jest.fn(),
    sceneExtensions: new Map(),
  } as unknown as IRenderer;
  let envelope: SceneEnvelope = {
    epoch: "one",
    revision: 1,
    savedRevision: 1,
    dirty: false,
    playing: false,
    sceneTime: 0,
    consumers: [],
    document: {
      schema: "xgc2.scene.v1",
      id: "test",
      frame: "world",
      obstacles: [createObstacle("Sphere", "sphere-1")],
    },
  };
  jest
    .spyOn(embeddedSceneBridge, "getBinding")
    .mockReturnValue({ namespace: "/xgc/scene", editable: true });
  const command = jest
    .spyOn(embeddedSceneBridge, "command")
    .mockImplementation(async (_, action) => {
      if (action.operation === "add") {
        envelope = {
          ...envelope,
          revision: envelope.revision + 1,
          dirty: false,
          savedRevision: envelope.revision + 1,
          document: {
            ...envelope.document,
            obstacles: [...envelope.document.obstacles, action.obstacle],
          },
        };
      } else if (action.operation === "update") {
        envelope = {
          ...envelope,
          revision: envelope.revision + 1,
          dirty: false,
          savedRevision: envelope.revision + 1,
          document: {
            ...envelope.document,
            obstacles: envelope.document.obstacles.map((o) =>
              o.id === action.obstacle.id ? action.obstacle : o,
            ),
          },
        };
      } else if (action.operation === "save") {
        envelope = {
          ...envelope,
          savedRevision: envelope.revision,
          dirty: false,
        };
      }
      return { success: true, ...envelope };
    });
  const extension = new ObstacleSceneExtension(renderer);
  renderer.sceneExtensions.set(ObstacleSceneExtension.extensionId, extension);
  const view = render(
    <RendererContext.Provider value={renderer}>
      <EmbeddedWorkspaceControlsProvider>
        <SceneTools />
        <ObstacleSceneEditor live />
      </EmbeddedWorkspaceControlsProvider>
    </RendererContext.Provider>,
  );
  act(() => { extension.session!.accept(envelope); });
  return {
    extension,
    command,
    view,
    renderer,
    dispose: () => {
      view.unmount();
      extension.dispose();
    },
  };
}

describe("obstacle editor operator flow", () => {
  it("adds live geometry with automatic persistence and can reload an agent edit", async () => {
    const { command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Add obstacle" }));
    await waitFor(() => {
      expect(screen.getByText("Autosaved")).toBeInTheDocument();
    });
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({
        operation: "add",
        obstacle: expect.objectContaining({
          name: "Box",
          pose: expect.objectContaining({ position: [12, 12, 0] }),
        }),
      }),
    );
    expect((command.mock.lastCall?.[1] as { obstacle: { id: string } }).obstacle.id).not.toBe(
      SCENE_DRAFT_ID,
    );
    expect(screen.getByRole("button", { name: "Retry save YAML" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload YAML" }));
    await waitFor(() => {
      expect(screen.getByText("Autosaved")).toBeInTheDocument();
    });
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({ operation: "reload" }),
    );
    dispose();
  });

  it("commits the edited placement pose instead of adding at the origin", async () => {
    const { command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Placement (m) X" })).toBeEnabled();
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Placement (m) X" }), {
      target: { value: "15" },
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "Placement (m) X" }));
    fireEvent.click(screen.getByRole("button", { name: "Add obstacle" }));
    await waitFor(() => {
      expect(command).toHaveBeenLastCalledWith(
        "/xgc/scene",
        expect.objectContaining({
          operation: "add",
          obstacle: expect.objectContaining({
            pose: expect.objectContaining({ position: [15, 12, 0] }),
          }),
        }),
      );
    });
    dispose();
  });

  it("snaps the selected obstacle onto the world ground plane", async () => {
    const { extension, command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    });
    const lifted = {
      ...extension.session!.getSnapshot().envelope!.document.obstacles[0]!,
      pose: {
        ...extension.session!.getSnapshot().envelope!.document.obstacles[0]!.pose,
        position: [1, 2, 4] as [number, number, number],
      },
    };
    act(() => {
      const current = extension.session!.getSnapshot().envelope!;
      extension.session!.accept({
        ...current,
        document: { ...current.document, obstacles: [lifted] },
      });
      extension.session!.select({ obstacleId: "sphere-1" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Snap to ground" }));
    await waitFor(() => {
      expect(command).toHaveBeenLastCalledWith(
        "/xgc/scene",
        expect.objectContaining({
          operation: "update",
          obstacle: expect.objectContaining({
            id: "sphere-1",
          }),
        }),
      );
    });
    const updated = command.mock.lastCall?.[1] as { obstacle: { pose: { position: number[] } } };
    expect(updated.obstacle.pose.position[0]).toBe(1);
    expect(updated.obstacle.pose.position[1]).toBe(2);
    expect(updated.obstacle.pose.position[2]).toBeCloseTo(0, 5);
    dispose();
  });

  it("commits radius on confirmation and exposes failures as errors with accepted geometry retained", async () => {
    const { extension, command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    });
    act(() => {
      extension.session!.select({ obstacleId: "sphere-1" });
    });
    const radius = screen.getByRole("textbox", { name: "Radius (m)" });
    fireEvent.change(radius, { target: { value: "0.8" } });
    fireEvent.blur(radius);
    await waitFor(() => {
      expect(screen.getByText("Autosaved")).toBeInTheDocument();
    });
    expect(
      extension.session!.getSnapshot().envelope!.document.obstacles[0]!.parts[0]!.geometry,
    ).toEqual({ type: "sphere", radius: 0.8 });
    command.mockResolvedValue({
      success: false,
      error: "Collision update failed. Check Gazebo.",
    });
    fireEvent.change(radius, { target: { value: "2" } });
    fireEvent.blur(radius);
    await waitFor(() => {
      expect(screen.getByText("Collision update failed. Check Gazebo.")).toBeInTheDocument();
    });
    expect(radius).toHaveValue("0.8");
    expect(screen.getByRole("button", { name: "Add obstacle" })).toBeDisabled();
    dispose();
  });

  it("retains a live edit after a write failure and allows retry without another mutation", async () => {
    const { extension, command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => { expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled(); });
    const current = extension.session!.getSnapshot().envelope!;
    const accepted = {
      ...current,
      revision: 2,
      dirty: true,
      document: {
        ...current.document,
        obstacles: [...current.document.obstacles, createObstacle("Box", "new")],
      },
    };
    command.mockResolvedValueOnce({
      ...accepted,
      success: false,
      error: "Live scene updated, but YAML was not saved: disk full",
    });
    fireEvent.click(screen.getByRole("button", { name: "Add obstacle" }));
    await waitFor(() =>
      { expect(screen.getByRole("button", { name: "Retry save YAML" })).toBeEnabled(); },
    );
    expect(extension.session!.getSnapshot().envelope!.document.obstacles).toHaveLength(2);
    expect(screen.getByText("Live changes · YAML not saved")).toBeInTheDocument();
    command.mockResolvedValueOnce({
      ...accepted,
      success: true,
      dirty: false,
      savedRevision: 2,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry save YAML" }));
    await waitFor(() => { expect(screen.getByText("Autosaved")).toBeInTheDocument(); });
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({ operation: "save", expectedRevision: 2 }),
    );
    dispose();
  });

  it("displays unsynchronized consumers without calling the scene fully applied", async () => {
    const { extension, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    });
    act(() => {
      extension.session!.accept({
        ...extension.session!.getSnapshot().envelope,
        synchronized: false,
        consumers: [
          {
            consumer: "gazebo",
            epoch: "one",
            revision: 1,
            applied: false,
            operational: false,
            capability: "",
            success: false,
            message: "Gazebo collision update failed",
          },
        ],
      });
    });
    expect(screen.getByText("Gazebo collision update failed")).toBeInTheDocument();
    expect(
      screen.getByText("The scene update is not synchronized everywhere. Check the errors or retry synchronization."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry sync" })).toBeEnabled();
    dispose();
  });

  it("does not tell the operator to retry a declared Reset capability gap", async () => {
    const { extension, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    });
    act(() => {
      extension.session!.accept({
        ...extension.session!.getSnapshot().envelope,
        synchronized: false,
        syncRetryable: false,
        consumers: [
          {
            consumer: "gazebo",
            epoch: "one",
            revision: 1,
            applied: true,
            operational: true,
            capability: "ok",
            success: true,
            message: "applied",
          },
          {
            consumer: "ugv-reset",
            epoch: "one",
            revision: 1,
            applied: false,
            operational: false,
            capability: "unsupported",
            success: false,
            message: "unsupported motion type: spiral",
          },
        ],
      });
    });
    expect(screen.getByText("unsupported motion type: spiral")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The scene is saved, but a consumer cannot apply this version. Retrying sync will not change that capability.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry sync" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    dispose();
  });
});
