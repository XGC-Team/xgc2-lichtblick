/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import "@testing-library/jest-dom";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

import { embeddedSceneBridge } from "@lichtblick/suite-base/components/EmbeddedSceneBridge";
import {
  EmbeddedWorkspaceControlsProvider,
  useEmbeddedWorkspaceControls,
} from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";

import { ObstacleSceneEditor } from "./ObstacleSceneEditor";
import { ObstacleSceneExtension } from "./ObstacleSceneExtension";
import { createObstacle, SCENE_DRAFT_ID, type ScenePreset } from "./geometry";
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

function setup(preset: ScenePreset = "Sphere") {
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
      obstacles: [createObstacle(preset, "sphere-1")],
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
  act(() => {
    extension.session!.accept(envelope);
  });
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
  it("shows live scale dimensions without changing the accepted scene, then commits the same geometry", async () => {
    const { extension, command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    act(() => {
      extension.session!.select({ obstacleId: "sphere-1" });
    });
    const scale = screen.getByRole("button", { name: "Scale" });
    expect(scale).toBeEnabled();
    fireEvent.click(scale);
    expect(scale).toHaveAttribute("aria-pressed", "true");
    const controls = extension.children.find((child) => child instanceof TransformControls)!;
    act(() => {
      controls.dispatchEvent({ type: "mouseDown" });
      controls.object!.scale.setScalar(2);
      controls.dispatchEvent({ type: "objectChange" });
    });
    expect(screen.getByLabelText("Radius (m)")).toHaveValue("1");
    expect(
      extension.session!.getSnapshot().envelope!.document.obstacles[0]!.parts[0]!.geometry,
    ).toEqual({ type: "sphere", radius: 0.5 });
    expect(command).not.toHaveBeenCalled();
    await act(async () => {
      controls.dispatchEvent({ type: "mouseUp" });
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Radius (m)")).toHaveValue("1");
    expect(screen.getByLabelText("Radius (m)")).toBeEnabled();
    expect(extension.getTransformSnapshot().preview).toBeUndefined();
    fireEvent.change(screen.getByLabelText("Radius (m)"), { target: { value: "1.5" } });
    fireEvent.keyDown(screen.getByLabelText("Radius (m)"), { key: "Enter" });
    // jsdom does not focus a field on change, unlike an operator click.
    fireEvent.blur(screen.getByLabelText("Radius (m)"));
    await waitFor(() => {
      expect(command).toHaveBeenCalledTimes(2);
    });
    expect(
      extension.session!.getSnapshot().envelope!.document.obstacles[0]!.parts[0]!.geometry,
    ).toEqual({ type: "sphere", radius: 1.5 });
    dispose();
  });

  it("updates position and rotation fields during drags and restores them on cancellation", async () => {
    const { extension, command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    act(() => {
      extension.session!.select({ obstacleId: "sphere-1" });
    });
    const controls = extension.children.find((child) => child instanceof TransformControls)!;
    act(() => {
      controls.dispatchEvent({ type: "mouseDown" });
      controls.object!.position.x = 3;
      controls.dispatchEvent({ type: "objectChange" });
    });
    expect(screen.getByLabelText("Initial position (m) X")).toHaveValue("3");
    act(() => {
      extension.cancelPreview();
    });
    expect(screen.getByLabelText("Initial position (m) X")).toHaveValue("0");
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    act(() => {
      controls.dispatchEvent({ type: "mouseDown" });
      controls.object!.quaternion.setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
      controls.dispatchEvent({ type: "objectChange" });
    });
    expect(screen.getByLabelText("Initial rotation XYZ (deg) Z")).toHaveValue("90");
    act(() => {
      extension.cancelPreview();
    });
    expect(screen.getByLabelText("Initial rotation XYZ (deg) Z")).toHaveValue("0");
    expect(command).not.toHaveBeenCalled();
    dispose();
  });

  it("applies a numeric whole-compound factor once and resets its relative baseline after acknowledgement", async () => {
    const { extension, command, dispose } = setup("Arch");
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    act(() => {
      extension.session!.select({ obstacleId: "sphere-1" });
    });
    expect(screen.getByRole("button", { name: "Scale" })).toBeEnabled();
    const factor = screen.getByLabelText("Whole obstacle scale factor");
    fireEvent.change(factor, { target: { value: "2" } });
    fireEvent.blur(factor);
    await waitFor(() => {
      expect(command).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Whole obstacle scale factor")).toBeEnabled();
      expect(screen.getByLabelText("Whole obstacle scale factor")).toHaveValue("1");
    });
    const resized = extension.session!.getSnapshot().envelope!.document.obstacles[0]!;
    expect(resized.parts).toHaveLength(3);
    expect(resized.parts[0]!.pose.position).toEqual([-2, 0, 2]);
    expect(resized.parts[0]!.geometry).toEqual({ type: "box", size: [0.8, 1.2, 4] });
    fireEvent.change(screen.getByLabelText("Whole obstacle scale factor"), {
      target: { value: "0" },
    });
    fireEvent.blur(screen.getByLabelText("Whole obstacle scale factor"));
    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("positive finite");
    dispose();
  });

  it("keeps the local-axis checkbox and selected mode synchronized with the actual controls", () => {
    const { extension, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    act(() => {
      extension.session!.select({ obstacleId: "sphere-1" });
    });
    const controls = extension.children.find((child) => child instanceof TransformControls)!;
    fireEvent.click(screen.getByRole("checkbox", { name: "Local axes" }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect(screen.getByRole("checkbox", { name: "Local axes" })).toBeChecked();
    expect(controls.space).toBe("local");
    fireEvent.click(screen.getByRole("button", { name: "Scale" }));
    expect(screen.getByRole("checkbox", { name: "Local axes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(screen.getByRole("checkbox", { name: "Local axes" })).toBeChecked();
    expect(controls.space).toBe("local");
    expect(screen.getByRole("button", { name: "Move" })).toHaveAttribute("aria-pressed", "true");
    dispose();
  });

  it("does not show another obstacle's pending scale factor after the selection changes", () => {
    const { extension, command, dispose } = setup("Arch");
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    act(() => {
      const envelope = extension.session!.getSnapshot().envelope!;
      extension.session!.accept({
        ...envelope,
        revision: 2,
        document: {
          ...envelope.document,
          obstacles: [...envelope.document.obstacles, createObstacle("Arch", "other")],
        },
      });
      extension.session!.select({ obstacleId: "sphere-1" });
    });
    command.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Scale" }));
    const controls = extension.children.find((child) => child instanceof TransformControls)!;
    act(() => {
      controls.dispatchEvent({ type: "mouseDown" });
      controls.object!.scale.setScalar(2);
      controls.dispatchEvent({ type: "objectChange" });
      controls.dispatchEvent({ type: "mouseUp" });
    });
    expect(screen.getByLabelText("Whole obstacle scale factor")).toHaveValue("2");
    act(() => {
      extension.session!.select({ obstacleId: "other" });
    });
    expect(screen.getByLabelText("Whole obstacle scale factor")).toHaveValue("1");
    expect(command).toHaveBeenCalledTimes(1);
    dispose();
  });

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
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    });
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
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry save YAML" })).toBeEnabled();
    });
    expect(extension.session!.getSnapshot().envelope!.document.obstacles).toHaveLength(2);
    expect(screen.getByText("Live changes · YAML not saved")).toBeInTheDocument();
    command.mockResolvedValueOnce({
      ...accepted,
      success: true,
      dirty: false,
      savedRevision: 2,
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry save YAML" }));
    await waitFor(() => {
      expect(screen.getByText("Autosaved")).toBeInTheDocument();
    });
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
      screen.getByText(
        "The scene update is not synchronized everywhere. Check the errors or retry synchronization.",
      ),
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
