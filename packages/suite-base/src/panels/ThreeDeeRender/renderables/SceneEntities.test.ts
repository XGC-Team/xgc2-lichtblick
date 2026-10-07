/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { LineType, SceneEntityDeletionType, SceneUpdate } from "@foxglove/schemas";
import * as THREE from "three";

import { makeSceneLayerClearEvent } from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/parkedParsePause";

import { FoxgloveSceneEntities } from "./SceneEntities";
import type { IRenderer, RendererConfig } from "../IRenderer";
import { PartialMessage } from "../SceneExtension";
import { RenderableLines } from "./primitives/RenderableLines";

const TOPIC = "/drones";
// Fresh object per call: tests mutate messages to simulate content changes
function identityPose() {
  return {
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");

function makeExtension(): FoxgloveSceneEntities {
  const config = { topics: {}, layers: {} } as unknown as RendererConfig;
  const renderer = {
    config,
    colorScheme: "dark",
    input: { canvasSize: new THREE.Vector2(640, 480) },
    topics: [],
    settings: {
      setNodesForKey: jest.fn(),
      errors: {
        add: jest.fn(),
        addToTopic: jest.fn(),
        removeFromTopic: jest.fn(),
        clearTopic: jest.fn(),
        clearPath: jest.fn(),
      },
    },
    updateConfig: (update: (draft: RendererConfig) => void) => {
      update(config);
    },
    normalizeFrameId: (id: string) => id.replace(/^\//, ""),
  } as unknown as IRenderer;
  return new FoxgloveSceneEntities(renderer);
}

function makeUpdate(): PartialMessage<SceneUpdate> {
  return {
    deletions: [],
    entities: [
      {
        id: "drone-1",
        frame_id: "world",
        timestamp: { sec: 1, nsec: 0 },
        lifetime: { sec: 1, nsec: 0 },
        lines: [
          {
            type: LineType.LINE_STRIP,
            pose: identityPose(),
            thickness: 0.1,
            scale_invariant: false,
            points: [
              { x: 0, y: 0, z: 0 },
              { x: 1, y: 1, z: 1 },
            ],
            color: { r: 1, g: 1, b: 1, a: 1 },
          },
        ],
      },
    ],
  };
}

function send(extension: FoxgloveSceneEntities, message: PartialMessage<SceneUpdate>, sec: number) {
  const sub = extension.getSubscriptions().find((entry) => entry.type === "schema");
  if (sub == undefined) {
    throw new Error("Missing SceneUpdate subscription");
  }
  sub.subscription.handler({
    topic: TOPIC,
    schemaName: "foxglove.SceneUpdate",
    receiveTime: { sec, nsec: 0 },
    sizeInBytes: 0,
    message,
  });
}

describe("FoxgloveSceneEntities republish diffing", () => {
  let extension: FoxgloveSceneEntities;

  beforeEach(() => {
    extension = makeExtension();
  });

  afterEach(() => {
    extension.dispose();
    jest.restoreAllMocks();
  });

  it("skips RenderableLines.update for unchanged geometry while refreshing expiry", () => {
    const updateSpy = jest.spyOn(RenderableLines.prototype, "update");

    send(extension, makeUpdate(), 1);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    send(extension, makeUpdate(), 2);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    const topicEntities = extension.renderables.get(TOPIC)!;
    const renderable = topicEntities.children[0] as RenderableLines;
    expect(renderable.userData.receiveTime).toBe(2_000_000_000n);
    expect(renderable.userData.expiresAt).toBe(2_000_000_000n + 1_000_000_000n);
    expect(renderable.userData.entity?.timestamp).toEqual({ sec: 1, nsec: 0 });
  });

  it("updates on changed geometry and after a deletion", () => {
    const updateSpy = jest.spyOn(RenderableLines.prototype, "update");

    send(extension, makeUpdate(), 1);

    const moved = makeUpdate();
    moved.entities![0]!.lines![0]!.points![1]!.x = 5;
    send(extension, moved, 2);
    expect(updateSpy).toHaveBeenCalledTimes(2);

    send(
      extension,
      { deletions: [{ type: SceneEntityDeletionType.MATCHING_ID, id: "drone-1" }] },
      3,
    );
    send(extension, makeUpdate(), 4);
    expect(updateSpy).toHaveBeenCalledTimes(3);
  });
});

describe("FoxgloveSceneEntities parked resume layer reset", () => {
  let extension: FoxgloveSceneEntities;

  beforeEach(() => {
    extension = makeExtension();
  });

  afterEach(() => {
    extension.dispose();
    jest.restoreAllMocks();
  });

  it("the player's synthetic clear empties the layer so a deletion missed while parked leaves no ghost", () => {
    // Before the park, the scene holds drone-1.
    send(extension, makeUpdate(), 1);
    const topicEntities = extension.renderables.get(TOPIC)!;
    expect(topicEntities.children.length).toBeGreaterThan(0);

    // While parked, the producer deletes drone-1; the viewer never sees that
    // deletion. On resume the player clears the layer BEFORE resubscribing.
    const clear = makeSceneLayerClearEvent({
      topic: TOPIC,
      schemaName: "foxglove.SceneUpdate",
      receiveTime: { sec: 2, nsec: 0 },
    });
    send(extension, clear.message as PartialMessage<SceneUpdate>, 2);
    expect(topicEntities.children).toHaveLength(0);

    // The next full publish repopulates current truth, which now contains
    // only drone-2: drone-1 from before the park can never reappear.
    const republish = makeUpdate();
    republish.entities![0]!.id = "drone-2";
    send(extension, republish, 3);
    const renderable = topicEntities.children[0] as RenderableLines;
    expect(renderable.userData.entity?.id).toBe("drone-2");
    expect(
      topicEntities.children.some(
        (child) => (child as RenderableLines).userData.entity?.id === "drone-1",
      ),
    ).toBe(false);
  });
});
