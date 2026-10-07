/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { ObjectPool } from "@lichtblick/den/collection";

import { PoolSlot, StaticLinkState, StaticVisualState } from "./UrdfInstancePool";
import { Urdfs } from "./Urdfs";
import type { IRenderer } from "../IRenderer";
import { SharedGeometry } from "../SharedGeometry";
import { Pose, makePose } from "../transforms";
import { MISSING_TRANSFORM } from "./transforms";
import { Transform } from "../transforms/Transform";
import { TransformTree } from "../transforms/TransformTree";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "draco.wasm");
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "");
jest.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/STLLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/ColladaLoader.js", () => ({}));

// base_link --(fixed, x+1 and 90° about z)--> arm_link --(continuous, y+1)--> rotor_link.
// base_link and arm_link are static and draw from the shared instance pools;
// rotor_link rides a continuous joint and keeps a per-link renderable.
// arm_link carries two visuals at distinct origins to cover multiple
// renderables sharing one frameId.
const urdf = `<robot name="test_robot">
  <link name="base_link">
    <visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual>
  </link>
  <link name="arm_link">
    <visual><origin xyz="0.1 0 0"/><geometry><box size="0.1 0.1 0.1"/></geometry></visual>
    <visual><origin xyz="0.2 0 0"/><geometry><box size="0.1 0.1 0.1"/></geometry></visual>
  </link>
  <link name="rotor_link">
    <visual><geometry><box size="0.1 0 0.1"/></geometry></visual>
  </link>
  <joint name="base_to_arm" type="fixed">
    <parent link="base_link"/><child link="arm_link"/>
    <origin xyz="1 0 0" rpy="0 0 1.5707963267948966"/>
  </joint>
  <joint name="arm_to_rotor" type="continuous">
    <parent link="arm_link"/><child link="rotor_link"/>
    <origin xyz="0 1 0"/>
  </joint>
</robot>`;

const HALF_SQRT2 = Math.SQRT1_2;

function translation(x: number, y: number, z: number): Transform {
  return new Transform([x, y, z], [0, 0, 0, 1]);
}

function setup({ scale }: { scale?: number } = {}) {
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith(".urdf")) {
      return { data: new TextEncoder().encode(urdf), mediaType: "application/xml" };
    }
    throw new Error(`Unowned asset ${url}`);
  });
  const transformTree = new TransformTree(new ObjectPool(Transform.Empty));
  const renderer = {
    fixedFrameId: "world",
    fetchAsset,
    transformTree,
    sharedGeometry: new SharedGeometry(),
    outlineMaterial: new THREE.LineBasicMaterial({ dithering: true }),
    on: jest.fn(),
    addCustomLayerAction: jest.fn(),
    config: {
      followTf: undefined,
      followMode: "follow-pose",
      layers: {
        model: {
          layerId: "foxglove.Urdf",
          sourceType: "url",
          url: "https://models.invalid/robot.urdf",
          label: "Robot",
          framePrefix: "",
          scale,
        },
      },
      topics: {},
    },
    settings: {
      handleAction: jest.fn(),
      setNodesForKey: jest.fn(),
      errors: {
        add: jest.fn(),
        remove: jest.fn(),
        clearPath: jest.fn(),
        hasError: jest.fn(() => false),
      },
    },
    updateConfig: jest.fn(),
    addCoordinateFrame: jest.fn((frameId: string) => {
      transformTree.getOrCreateFrame(frameId);
    }),
    addTransform: jest.fn(
      (
        parent: string,
        child: string,
        stamp: bigint,
        t: { x: number; y: number; z: number },
        q: { x: number; y: number; z: number; w: number },
      ) => {
        transformTree.addTransform(
          child,
          parent,
          stamp,
          new Transform([t.x, t.y, t.z], [q.x, q.y, q.z, q.w]),
        );
      },
    ),
    removeTransform: jest.fn((child: string, parent: string, stamp: bigint) => {
      transformTree.removeTransform(child, parent, stamp);
    }),
    normalizeFrameId: (frame: string) => frame,
    queueAnimationFrame: jest.fn(),
  };
  const extension = new Urdfs(renderer as unknown as IRenderer);
  return { extension, renderer, transformTree };
}

/** Per-link legacy renderables grouped by their shared coordinate frame id. */
function linksByFrameId(extension: Urdfs): Map<string, THREE.Object3D[]> {
  const renderable = extension.renderables.get("model")!;
  const byFrame = new Map<string, THREE.Object3D[]>();
  for (const child of renderable.userData.renderables.values()) {
    const frameId = child.userData.frameId;
    const list = byFrame.get(frameId) ?? [];
    list.push(child);
    byFrame.set(frameId, list);
  }
  return byFrame;
}

function staticLink(extension: Urdfs, frameId: string): StaticLinkState {
  const link = extension.renderables
    .get("model")!
    .userData.instancing?.staticLinks.find((candidate) => candidate.frameId === frameId);
  if (!link) {
    throw new Error(`No pooled static link ${frameId}`);
  }
  return link;
}

/** Rebase-origin-independent world matrix of one pooled instance. */
function slotWorldMatrix(slot: PoolSlot): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  slot.batch.instancedMesh().getMatrixAt(slot.index, matrix);
  matrix.elements[12]! += slot.batch.position.x;
  matrix.elements[13]! += slot.batch.position.y;
  matrix.elements[14]! += slot.batch.position.z;
  return matrix;
}

const tempPos = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();
const tempScale = new THREE.Vector3();

/**
 * Ground truth for one pooled visual: the full tree query the legacy per-link
 * path issues, with the layer scale pre-applied to the visual origin exactly
 * like the legacy load-time pose scaling.
 */
function expectSlotMatchesFullTreeQuery(
  transformTree: TransformTree,
  slot: PoolSlot,
  visual: StaticVisualState,
  linkFrameId: string,
  scale: number,
  time: bigint,
): void {
  const truth = makePose();
  const truthPose: Pose = {
    position: {
      x: visual.pose.position.x * scale,
      y: visual.pose.position.y * scale,
      z: visual.pose.position.z * scale,
    },
    orientation: visual.pose.orientation,
  };
  const applied = transformTree.apply(truth, truthPose, "world", "world", linkFrameId, time, time);
  expect(applied).toBeDefined();
  slotWorldMatrix(slot).decompose(tempPos, tempQuat, tempScale);
  expect(tempPos.x).toBeCloseTo(truth.position.x);
  expect(tempPos.y).toBeCloseTo(truth.position.y);
  expect(tempPos.z).toBeCloseTo(truth.position.z);
  expect(tempQuat.x).toBeCloseTo(truth.orientation.x);
  expect(tempQuat.y).toBeCloseTo(truth.orientation.y);
  expect(tempQuat.z).toBeCloseTo(truth.orientation.z);
  expect(tempQuat.w).toBeCloseTo(truth.orientation.w);
  expect(tempScale.x).toBeCloseTo(visual.dims.x * scale);
  expect(tempScale.y).toBeCloseTo(visual.dims.y * scale);
  expect(tempScale.z).toBeCloseTo(visual.dims.z * scale);
}

/**
 * Ground truth for one pooled visual on a display-scaled layer: the legacy
 * #applyScaledChildPose composition — root.t + root.q·(scale·rel.t) +
 * (root.q·rel.q)·(scale·visual.t) with (scale·dims) as the matrix scale —
 * resolved here straight from the transform tree.
 */
function expectSlotMatchesScaledCompose(
  transformTree: TransformTree,
  slot: PoolSlot,
  visual: StaticVisualState,
  rootFrameId: string,
  linkFrameId: string,
  scale: number,
  time: bigint,
): void {
  const rootTruth = makePose();
  expect(
    transformTree.apply(rootTruth, makePose(), "world", "world", rootFrameId, time, time),
  ).toBeDefined();
  const relTruth = makePose();
  expect(
    transformTree.apply(relTruth, makePose(), rootFrameId, rootFrameId, linkFrameId, time, time),
  ).toBeDefined();
  const rootQuat = new THREE.Quaternion(
    rootTruth.orientation.x,
    rootTruth.orientation.y,
    rootTruth.orientation.z,
    rootTruth.orientation.w,
  );
  const chainQuat = rootQuat
    .clone()
    .multiply(
      new THREE.Quaternion(
        relTruth.orientation.x,
        relTruth.orientation.y,
        relTruth.orientation.z,
        relTruth.orientation.w,
      ),
    );
  const expectedPos = new THREE.Vector3(
    relTruth.position.x * scale,
    relTruth.position.y * scale,
    relTruth.position.z * scale,
  )
    .applyQuaternion(rootQuat)
    .add(
      new THREE.Vector3(rootTruth.position.x, rootTruth.position.y, rootTruth.position.z),
    )
    .add(
      new THREE.Vector3(
        visual.pose.position.x * scale,
        visual.pose.position.y * scale,
        visual.pose.position.z * scale,
      ).applyQuaternion(chainQuat),
    );
  const expectedQuat = chainQuat.multiply(
    new THREE.Quaternion(
      visual.pose.orientation.x,
      visual.pose.orientation.y,
      visual.pose.orientation.z,
      visual.pose.orientation.w,
    ),
  );
  slotWorldMatrix(slot).decompose(tempPos, tempQuat, tempScale);
  expect(tempPos.x).toBeCloseTo(expectedPos.x);
  expect(tempPos.y).toBeCloseTo(expectedPos.y);
  expect(tempPos.z).toBeCloseTo(expectedPos.z);
  expect(tempQuat.x).toBeCloseTo(expectedQuat.x);
  expect(tempQuat.y).toBeCloseTo(expectedQuat.y);
  expect(tempQuat.z).toBeCloseTo(expectedQuat.z);
  expect(tempQuat.w).toBeCloseTo(expectedQuat.w);
  expect(tempScale.x).toBeCloseTo(visual.dims.x * scale);
  expect(tempScale.y).toBeCloseTo(visual.dims.y * scale);
  expect(tempScale.z).toBeCloseTo(visual.dims.z * scale);
}

/** Ground truth: the full tree query the unhoisted updatePose() would issue. */
function expectMatchesFullTreeQuery(
  transformTree: TransformTree,
  child: THREE.Object3D,
  time: bigint,
): void {
  const truth = makePose();
  const applied = transformTree.apply(
    truth,
    child.userData.pose as Pose,
    "world",
    "world",
    child.userData.frameId as string,
    time,
    time,
  );
  expect(applied).toBeDefined();
  expect(child.position.x).toBeCloseTo(truth.position.x);
  expect(child.position.y).toBeCloseTo(truth.position.y);
  expect(child.position.z).toBeCloseTo(truth.position.z);
  expect(child.quaternion.x).toBeCloseTo(truth.orientation.x);
  expect(child.quaternion.y).toBeCloseTo(truth.orientation.y);
  expect(child.quaternion.z).toBeCloseTo(truth.orientation.z);
  expect(child.quaternion.w).toBeCloseTo(truth.orientation.w);
}

describe("Urdfs startFrame pose updates", () => {
  it("performs no tree apply calls for links on the second frame with unchanged TF", async () => {
    const { extension, transformTree } = setup();
    await extension.settleVideoDecodes();
    transformTree.addTransform("base_link", "world", 0n, translation(10, 0, 0));
    const links = linksByFrameId(extension);
    // Only the articulated rotor link keeps per-link renderables; the static
    // base and arm links draw from the shared box batch.
    expect(links.get("base_link")).toBeUndefined();
    expect(links.get("arm_link")).toBeUndefined();
    expect(links.get("rotor_link")).toHaveLength(1);
    const batches = extension.instancePool.batches();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.instancedMesh().count).toBe(3);
    const base = staticLink(extension, "base_link");
    const arm = staticLink(extension, "arm_link");
    expect(base.visuals).toHaveLength(1);
    expect(arm.visuals).toHaveLength(2);

    const applySpy = jest.spyOn(transformTree, "apply");
    extension.startFrame(100n, "world", "world");
    // First frame resolves everything: one hoisted root query for the robot,
    // one root->link query per pooled static link (base, arm), and one for the
    // legacy rotor link.
    expect(applySpy.mock.calls.length).toBe(4);

    // Pooled instance matrices match the unhoisted full-tree query, including
    // the rotated joint and the two distinct arm visual origins.
    expectSlotMatchesFullTreeQuery(transformTree, base.visuals[0]!.slots[0]!, base.visuals[0]!, "base_link", 1, 100n);
    const basePos = new THREE.Vector3();
    slotWorldMatrix(base.visuals[0]!.slots[0]!).decompose(basePos, tempQuat, tempScale);
    expect(basePos.x).toBeCloseTo(10);
    expect(basePos.y).toBeCloseTo(0);
    for (const visual of arm.visuals) {
      expectSlotMatchesFullTreeQuery(transformTree, visual.slots[0]!, visual, "arm_link", 1, 100n);
    }
    const armPos = new THREE.Vector3();
    slotWorldMatrix(arm.visuals[0]!.slots[0]!).decompose(armPos, tempQuat, tempScale);
    expect(tempQuat.z).toBeCloseTo(HALF_SQRT2);
    expect(tempQuat.w).toBeCloseTo(HALF_SQRT2);
    // The legacy rotor renderable still matches the full-tree query.
    const rotor = links.get("rotor_link")![0]!;
    expect(rotor.visible).toBe(true);
    expectMatchesFullTreeQuery(transformTree, rotor, 100n);
    expect(rotor.position.x).toBeCloseTo(10);
    expect(rotor.position.y).toBeCloseTo(0);

    applySpy.mockClear();
    extension.startFrame(200n, "world", "world");
    expect(applySpy).not.toHaveBeenCalled();
    expectSlotMatchesFullTreeQuery(transformTree, base.visuals[0]!.slots[0]!, base.visuals[0]!, "base_link", 1, 200n);
    expectMatchesFullTreeQuery(transformTree, rotor, 200n);

    extension.dispose();
  });

  it("recomputes only the changed dynamic joint chain", async () => {
    const { extension, transformTree } = setup();
    await extension.settleVideoDecodes();
    transformTree.addTransform("base_link", "world", 0n, translation(10, 0, 0));
    const links = linksByFrameId(extension);
    const arm = staticLink(extension, "arm_link");

    extension.startFrame(100n, "world", "world");
    const rotor = links.get("rotor_link")![0]!;
    expect(rotor.position.x).toBeCloseTo(10);

    // A dynamic joint update: rotor_link swings out at t=200n.
    transformTree.addTransform("rotor_link", "arm_link", 200n, translation(0, 2, 0));
    const applySpy = jest.spyOn(transformTree, "apply");
    extension.startFrame(300n, "world", "world");

    // Exactly one recompute: the rotor link's root->link transform. The hoisted
    // root pose and the pooled static link chains stay memoized.
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "base_link",
      "base_link",
      "rotor_link",
      300n,
      300n,
    );
    for (const visual of arm.visuals) {
      expectSlotMatchesFullTreeQuery(transformTree, visual.slots[0]!, visual, "arm_link", 1, 300n);
    }
    expectMatchesFullTreeQuery(transformTree, rotor, 300n);

    // Settled again: the next frame reuses everything.
    applySpy.mockClear();
    extension.startFrame(400n, "world", "world");
    expect(applySpy).not.toHaveBeenCalled();

    extension.dispose();
  });

  it("routes the scaled path through the memo with no raw tree apply on the second frame", async () => {
    const { extension, transformTree } = setup({ scale: 2 });
    await extension.settleVideoDecodes();
    transformTree.addTransform("base_link", "world", 0n, translation(10, 0, 0));
    const links = linksByFrameId(extension);
    const base = staticLink(extension, "base_link");
    const arm = staticLink(extension, "arm_link");

    const applySpy = jest.spyOn(transformTree, "apply");
    extension.startFrame(100n, "world", "world");
    expect(applySpy.mock.calls.length).toBe(4);

    // Display scale doubles the root->link translations: base stays at the
    // root, arm rides at x+2, and the 90° joint swings the doubled rotor
    // offset (y+2) back onto the root. Visual origins are folded into the
    // instance matrices with the same factor and ride the joint rotation.
    expectSlotMatchesScaledCompose(
      transformTree,
      base.visuals[0]!.slots[0]!,
      base.visuals[0]!,
      "base_link",
      "base_link",
      2,
      100n,
    );
    for (const visual of arm.visuals) {
      expectSlotMatchesScaledCompose(
        transformTree,
        visual.slots[0]!,
        visual,
        "base_link",
        "arm_link",
        2,
        100n,
      );
    }
    const armY = arm.visuals.map((visual) => {
      const pos = new THREE.Vector3();
      slotWorldMatrix(visual.slots[0]!).decompose(pos, tempQuat, tempScale);
      return pos.y;
    });
    expect(armY[0]).toBeCloseTo(0.2);
    expect(armY[1]).toBeCloseTo(0.4);
    const rotor = links.get("rotor_link")![0]!;
    expect(rotor.position.x).toBeCloseTo(10);
    expect(rotor.position.y).toBeCloseTo(0);

    applySpy.mockClear();
    extension.startFrame(200n, "world", "world");
    expect(applySpy).not.toHaveBeenCalled();
    expect(rotor.position.x).toBeCloseTo(10);

    extension.dispose();
  });

  it("keeps per-link invisibility and the aggregated MISSING_TRANSFORM error", async () => {
    const { extension, renderer } = setup();
    await extension.settleVideoDecodes();
    const links = linksByFrameId(extension);
    const errorsAdd = renderer.settings.errors.add;

    // No world->base_link transform: the robot root never resolves, so the
    // legacy link fails and the layer reports the last missing frame once per
    // frame. Pooled static links hide their instances as well.
    extension.startFrame(100n, "world", "world");
    for (const children of links.values()) {
      for (const child of children) {
        expect(child.visible).toBe(false);
      }
    }
    const missingCalls = errorsAdd.mock.calls.filter(([, id]) => id === MISSING_TRANSFORM);
    expect(missingCalls).toHaveLength(1);
    expect(missingCalls[0]![0]).toEqual(["layers", "model"]);
    expect(missingCalls[0]![2]).toContain("<rotor_link>");
    expect(missingCalls[0]![2]).toContain("<world>");
    const batch = extension.instancePool.batches()[0]!;
    expect(batch.instancedMesh().visible).toBe(false);

    errorsAdd.mockClear();
    extension.startFrame(101n, "world", "world");
    const secondMissingCalls = errorsAdd.mock.calls.filter(([, id]) => id === MISSING_TRANSFORM);
    expect(secondMissingCalls).toHaveLength(1);
    expect(secondMissingCalls[0]![2]).toBe(missingCalls[0]![2]);

    extension.dispose();
  });
});
