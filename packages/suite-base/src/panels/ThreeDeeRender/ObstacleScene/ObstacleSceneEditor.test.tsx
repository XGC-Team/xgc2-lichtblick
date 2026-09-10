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

import { ObstacleSceneEditor } from "./ObstacleSceneEditor";
import { ObstacleSceneExtension } from "./ObstacleSceneExtension";
import { createObstacle } from "./geometry";
import type { SceneEnvelope } from "./types";
import type { IRenderer } from "../IRenderer";
import { RendererContext } from "../RendererContext";

jest.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "en" } }) }));

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
          dirty: true,
          document: {
            ...envelope.document,
            obstacles: [...envelope.document.obstacles, action.obstacle],
          },
        };
      } else if (action.operation === "update") {
        envelope = {
          ...envelope,
          revision: envelope.revision + 1,
          dirty: true,
          document: {
            ...envelope.document,
            obstacles: envelope.document.obstacles.map((o) =>
              o.id === action.obstacle.id ? action.obstacle : o,
            ),
          },
        };
      } else if (action.operation === "save") {
        envelope = { ...envelope, savedRevision: envelope.revision, dirty: false };
      }
      return { success: true, ...envelope };
    });
  const extension = new ObstacleSceneExtension(renderer);
  renderer.sceneExtensions.set(ObstacleSceneExtension.extensionId, extension);
  const view = render(
    <RendererContext.Provider value={renderer}>
      <ObstacleSceneEditor live />
    </RendererContext.Provider>,
  );
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
  it("adds live geometry and saves without a separate apply step", async () => {
    const { command, dispose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Obstacle scene" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Add obstacle" }));
    await waitFor(() => {
      expect(screen.getByText("Live changes · Unsaved")).toBeInTheDocument();
    });
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({
        operation: "add",
        obstacle: expect.objectContaining({ name: "Box" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save YAML" }));
    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({ operation: "save" }),
    );
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
      expect(screen.getByText("Live changes · Unsaved")).toBeInTheDocument();
    });
    expect(
      extension.session!.getSnapshot().envelope!.document.obstacles[0]!.parts[0]!.geometry,
    ).toEqual({ type: "sphere", radius: 0.8 });
    command.mockResolvedValue({ success: false, error: "Collision update failed. Check Gazebo." });
    fireEvent.change(radius, { target: { value: "2" } });
    fireEvent.blur(radius);
    await waitFor(() => {
      expect(screen.getByText("Collision update failed. Check Gazebo.")).toBeInTheDocument();
    });
    expect(radius).toHaveValue("0.8");
    expect(screen.getByRole("button", { name: "Add obstacle" })).toBeDisabled();
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
            consumer: "planner",
            revision: 0,
            success: false,
            message: "The planner does not support this motion. Select hold or constant twist.",
          },
        ],
      });
    });
    expect(
      screen.getByText("The planner does not support this motion. Select hold or constant twist."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for scene consumers; the update is not yet applied everywhere."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add obstacle" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry sync" })).toBeEnabled();
    dispose();
  });
});
