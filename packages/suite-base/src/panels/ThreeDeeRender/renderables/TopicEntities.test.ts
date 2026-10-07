/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { LinePrimitive, LineType, SceneEntity, SceneEntityDeletionType } from "@foxglove/schemas";

import { toNanoSec } from "@lichtblick/rostime";

import { TopicEntities, EntityTopicUserData } from "./TopicEntities";
import { PrimitivePool } from "./primitives/PrimitivePool";
import { RenderablePrimitive } from "./primitives/RenderablePrimitive";
import { PrimitiveType } from "./primitives/constants";
import { hashSceneEntityContent } from "./sceneEntityHash";
import type { IRenderer } from "../IRenderer";
import { LayerSettingsEntity } from "../settings";
import { makePose } from "../transforms";

const TOPIC = "/drones";
// Fresh object per call: tests mutate poses to simulate content changes
function identityPose() {
  return {
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  };
}
const WHITE = { r: 1, g: 1, b: 1, a: 1 };

const SETTINGS: LayerSettingsEntity = {
  visible: true,
  showOutlines: true,
  color: undefined,
  backgroundColor: undefined,
  showBackground: undefined,
  selectedIdVariable: undefined,
};

// Mirrors the per-message bookkeeping every primitive renderable performs in
// update(): store userData and recompute expiry from receiveTime + lifetime.
class MockPrimitive extends RenderablePrimitive {
  public override update(
    topic: string | undefined,
    entity: SceneEntity | undefined,
    settings: LayerSettingsEntity,
    receiveTime: bigint,
  ): void {
    super.update(topic, entity, settings, receiveTime);
    if (entity) {
      const lifetimeNs = toNanoSec(entity.lifetime);
      this.userData.expiresAt = lifetimeNs === 0n ? undefined : receiveTime + lifetimeNs;
    }
  }
}

function makeRenderer(): IRenderer {
  return {
    colorScheme: "dark",
    normalizeFrameId: (id: string) => id,
    transformTree: { frame: () => undefined, apply: () => false },
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
  } as unknown as IRenderer;
}

function makeLine(overrides: Partial<LinePrimitive> = {}): LinePrimitive {
  return {
    type: LineType.LINE_STRIP,
    pose: identityPose(),
    thickness: 0.1,
    scale_invariant: false,
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ],
    color: WHITE,
    colors: [],
    indices: [],
    ...overrides,
  };
}

function makeEntity(overrides: Partial<SceneEntity> = {}): SceneEntity {
  return {
    timestamp: { sec: 1, nsec: 0 },
    frame_id: "world",
    id: "drone-1",
    lifetime: { sec: 1, nsec: 0 },
    frame_locked: false,
    metadata: [],
    arrows: [],
    cubes: [],
    spheres: [],
    cylinders: [],
    lines: [makeLine()],
    triangles: [],
    texts: [],
    models: [],
    ...overrides,
  };
}

function makeUserData(): EntityTopicUserData {
  return {
    receiveTime: -1n,
    messageTime: -1n,
    frameId: "",
    pose: makePose(),
    settingsPath: ["topics", TOPIC],
    topic: TOPIC,
    settings: { ...SETTINGS },
  };
}

function setup() {
  const renderer = makeRenderer();
  // Faithful to PrimitivePool reuse semantics: released renderables are shifted
  // back out for the next acquire, possibly serving a different entity id.
  const pooled: MockPrimitive[] = [];
  const acquire = jest.fn((_type: PrimitiveType): MockPrimitive => {
    const reused = pooled.shift();
    if (reused) {
      reused.prepareForReuse();
      return reused;
    }
    return new MockPrimitive("", renderer);
  });
  const release = jest.fn((_type: PrimitiveType, renderable: MockPrimitive) => {
    pooled.push(renderable);
  });
  const pool = { acquire, release } as unknown as PrimitivePool;
  const updateSpy = jest.spyOn(MockPrimitive.prototype, "update");
  const topicEntities = new TopicEntities(TOPIC, pool, renderer, makeUserData());
  return { topicEntities, acquire, release, updateSpy };
}

function deleteById(topicEntities: TopicEntities, id: string): void {
  topicEntities.deleteEntities({
    timestamp: { sec: 0, nsec: 0 },
    type: SceneEntityDeletionType.MATCHING_ID,
    id,
  });
}

describe("TopicEntities content diff", () => {
  it("skips renderable.update for an unchanged entity but refreshes expiry and entity state", () => {
    const { topicEntities, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    const renderable = topicEntities.children[0] as MockPrimitive;
    expect(renderable.userData.expiresAt).toBe(100n + 1_000_000_000n);

    // Each message normalizes into a fresh object graph; only timestamp and
    // metadata (non-geometry fields) differ here.
    const second = makeEntity({
      timestamp: { sec: 2, nsec: 0 },
      metadata: [{ key: "k", value: "v" }],
    });
    topicEntities.addOrUpdateEntity(second, 200n);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(renderable.userData.entity).toBe(second);
    expect(renderable.userData.receiveTime).toBe(200n);
    expect(renderable.userData.expiresAt).toBe(200n + 1_000_000_000n);
    expect(renderable.details()).toBe(second);
  });

  it("updates when line points change", () => {
    const { topicEntities, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    topicEntities.addOrUpdateEntity(
      makeEntity({ lines: [makeLine({ points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 }] })] }),
      200n,
    );
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("updates when only a primitive pose changes", () => {
    const { topicEntities, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    const moved = makeEntity();
    moved.lines[0]!.pose.position.x = 5;
    topicEntities.addOrUpdateEntity(moved, 200n);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("updates all primitive renderables of an entity when any one of them changes", () => {
    const { topicEntities, updateSpy } = setup();
    const withCube = makeEntity({
      cubes: [{ pose: identityPose(), size: { x: 1, y: 1, z: 1 }, color: WHITE }],
    });
    topicEntities.addOrUpdateEntity(withCube, 100n);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(topicEntities.children).toHaveLength(2);

    topicEntities.addOrUpdateEntity(withCube, 200n);
    expect(updateSpy).toHaveBeenCalledTimes(2);

    const resized = makeEntity({
      cubes: [{ pose: identityPose(), size: { x: 2, y: 1, z: 1 }, color: WHITE }],
    });
    topicEntities.addOrUpdateEntity(resized, 300n);
    expect(updateSpy).toHaveBeenCalledTimes(4);
  });

  it("evicts the hash on MATCHING_ID deletion so identical re-added content updates", () => {
    const { topicEntities, acquire, release, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    const renderable = topicEntities.children[0] as MockPrimitive;

    deleteById(topicEntities, "drone-1");
    expect(release).toHaveBeenCalledWith(PrimitiveType.LINES, renderable);
    expect(topicEntities.children).toHaveLength(0);

    topicEntities.addOrUpdateEntity(makeEntity(), 200n);
    // The pooled renderable was reused and updated despite identical content
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(topicEntities.children[0]).toBe(renderable);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("evicts hashes on ALL deletion", () => {
    const { topicEntities, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    topicEntities.deleteEntities({
      timestamp: { sec: 0, nsec: 0 },
      type: SceneEntityDeletionType.ALL,
      id: "",
    });
    topicEntities.addOrUpdateEntity(makeEntity(), 200n);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("updates a pooled renderable reused by a different entity id with identical content", () => {
    const { topicEntities, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity({ id: "drone-a" }), 100n);
    const renderable = topicEntities.children[0] as MockPrimitive;

    deleteById(topicEntities, "drone-a");
    topicEntities.addOrUpdateEntity(makeEntity({ id: "drone-b" }), 200n);

    expect(topicEntities.children[0]).toBe(renderable);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(renderable.userData.entity?.id).toBe("drone-b");
  });

  it("still expires entities in startFrame and evicts their hash", () => {
    const { topicEntities, release, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    const renderable = topicEntities.children[0] as MockPrimitive;

    // Before expiry: entity stays
    topicEntities.startFrame(100n + 500_000_000n, "render", "fixed");
    expect(release).not.toHaveBeenCalled();

    // After receiveTime + lifetime: entity is removed and its renderable released
    topicEntities.startFrame(100n + 1_000_000_001n, "render", "fixed");
    expect(release).toHaveBeenCalledWith(PrimitiveType.LINES, renderable);
    expect(topicEntities.children).toHaveLength(0);

    topicEntities.addOrUpdateEntity(makeEntity(), 300n);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("refreshes expiry on the skip path so a republished entity never lapses", () => {
    const { topicEntities, release, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    // Same geometry republished just before expiry
    topicEntities.addOrUpdateEntity(makeEntity(), 100n + 900_000_000n);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    // Would have expired without the refreshed expiresAt
    topicEntities.startFrame(100n + 1_500_000_000n, "render", "fixed");
    expect(release).not.toHaveBeenCalled();
  });

  it("releases the renderable when the primitive array becomes empty and updates on refill", () => {
    const { topicEntities, acquire, release, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    const renderable = topicEntities.children[0] as MockPrimitive;

    topicEntities.addOrUpdateEntity(makeEntity({ lines: [] }), 200n);
    expect(release).toHaveBeenCalledWith(PrimitiveType.LINES, renderable);
    expect(topicEntities.children).toHaveLength(0);

    // An identical empty entity is a no-op: no renderables, nothing to refresh
    topicEntities.addOrUpdateEntity(makeEntity({ lines: [] }), 300n);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    // Refilling with the original content must update: the released renderable
    // cannot be trusted to still belong to this entity
    topicEntities.addOrUpdateEntity(makeEntity(), 400n);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("treats an invalid deletion type as an error without touching the hash", () => {
    const { topicEntities, updateSpy } = setup();
    topicEntities.addOrUpdateEntity(makeEntity(), 100n);
    topicEntities.deleteEntities({
      timestamp: { sec: 0, nsec: 0 },
      type: 99 as SceneEntityDeletionType,
      id: "drone-1",
    });
    // Entity survived; identical content still skips
    topicEntities.addOrUpdateEntity(makeEntity(), 200n);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});

describe("hashSceneEntityContent", () => {
  it("is equal for identical content in fresh objects", () => {
    expect(hashSceneEntityContent(makeEntity())).toBe(hashSceneEntityContent(makeEntity()));
  });

  it("ignores entity fields that never reach GPU buffers", () => {
    const base = makeEntity();
    const restamped = makeEntity({
      timestamp: { sec: 9, nsec: 9 },
      frame_id: "map",
      frame_locked: true,
      lifetime: { sec: 5, nsec: 0 },
      metadata: [{ key: "k", value: "v" }],
    });
    expect(hashSceneEntityContent(restamped)).toBe(hashSceneEntityContent(base));
  });

  it.each<[string, () => SceneEntity]>([
    ["line points", () => makeEntity({ lines: [makeLine({ points: [{ x: 9, y: 9, z: 9 }] })] })],
    [
      "line pose",
      () => {
        const entity = makeEntity();
        entity.lines[0]!.pose.position.x = 1;
        return entity;
      },
    ],
    ["line thickness", () => makeEntity({ lines: [makeLine({ thickness: 0.2 })] })],
    ["line color", () => makeEntity({ lines: [makeLine({ color: { r: 0, g: 0, b: 0, a: 1 } })] })],
    [
      "line vertex colors",
      () => makeEntity({ lines: [makeLine({ colors: [WHITE, WHITE] })] }),
    ],
    ["line indices", () => makeEntity({ lines: [makeLine({ indices: [0, 1] })] })],
    ["line type", () => makeEntity({ lines: [makeLine({ type: LineType.LINE_LIST })] })],
    ["line scale_invariant", () => makeEntity({ lines: [makeLine({ scale_invariant: true })] })],
    ["emptied lines", () => makeEntity({ lines: [] })],
    [
      "extra cube",
      () =>
        makeEntity({ cubes: [{ pose: identityPose(), size: { x: 1, y: 1, z: 1 }, color: WHITE }] }),
    ],
    [
      "text string",
      () =>
        makeEntity({
          texts: [
            {
              pose: identityPose(),
              billboard: true,
              font_size: 16,
              scale_invariant: true,
              color: WHITE,
              text: "a",
            },
          ],
        }),
    ],
    [
      "model url",
      () =>
        makeEntity({
          models: [
            {
              pose: identityPose(),
              scale: { x: 1, y: 1, z: 1 },
              color: WHITE,
              override_color: false,
              url: "https://example.com/model.glb",
              media_type: "model/gltf-binary",
              data: new Uint8Array(0),
            },
          ],
        }),
    ],
  ])("detects a change in %s", (_name, makeChanged) => {
    expect(hashSceneEntityContent(makeChanged())).not.toBe(hashSceneEntityContent(makeEntity()));
  });
});
