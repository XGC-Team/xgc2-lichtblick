/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { ObjectPool } from "@lichtblick/den/collection";

import { PoolSlot, StaticLinkState } from "./UrdfInstancePool";
import { Urdfs, UrdfRenderable } from "./Urdfs";
import type { IRenderer } from "../IRenderer";
import { InstancedLineMaterial } from "../IRenderer";
import { ModelCache } from "../ModelCache";
import { SharedGeometry } from "../SharedGeometry";
import { rgbToThreeColor } from "../color";
import { DetailLevel } from "../lod";
import { Vector3 } from "../ros";
import { makePose } from "../transforms";
import { Transform } from "../transforms/Transform";
import { TransformTree } from "../transforms/TransformTree";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "draco.wasm");
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "");
jest.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({}));
const mockCollada: { material: THREE.Material | undefined } = { material: undefined };
const mockParse = jest.fn((_manager: THREE.LoadingManager) => ({
  scene: colladaScene(),
}));
jest.mock("three/examples/jsm/loaders/ColladaLoader.js", () => ({
  ColladaLoader: class {
    public constructor(private mockManager: THREE.LoadingManager) {}
    public parse() {
      return mockParse(this.mockManager);
    }
  },
}));
const mockStl: { geometry: THREE.BufferGeometry | undefined } = { geometry: undefined };
jest.mock("three/examples/jsm/loaders/STLLoader.js", () => ({
  STLLoader: class {
    public parse() {
      const THREEActual = jest.requireActual<typeof import("three")>("three");
      mockStl.geometry = new THREEActual.BufferGeometry();
      return mockStl.geometry;
    }
  },
}));

// base_link --(fixed, x+1)--> arm_link --(continuous, y+1)--> rotor_link.
// base_link carries a red material; arm_link falls back to the layer color.
const primitiveUrdf = `<robot name="test_robot">
  <link name="base_link">
    <visual>
      <geometry><box size="0.1 0.1 0.1"/></geometry>
      <material name="red"><color rgba="1 0 0 1"/></material>
    </visual>
  </link>
  <link name="arm_link">
    <visual><origin xyz="0.1 0 0"/><geometry><box size="0.2 0.1 0.1"/></geometry></visual>
  </link>
  <link name="rotor_link">
    <visual><geometry><box size="0.1 0 0.1"/></geometry></visual>
  </link>
  <joint name="base_to_arm" type="fixed">
    <parent link="base_link"/><child link="arm_link"/>
    <origin xyz="1 0 0"/>
  </joint>
  <joint name="arm_to_rotor" type="continuous">
    <parent link="arm_link"/><child link="rotor_link"/>
    <origin xyz="0 1 0"/>
  </joint>
</robot>`;

function meshUrdf(filename: string): string {
  return `<robot name="mesh_robot">
  <link name="base_link">
    <visual><geometry><mesh filename="${filename}"/></geometry></visual>
  </link>
</robot>`;
}

// One-leaf Collada stand-in with a local offset to prove leaf transforms land
// in the instance matrices.
function colladaScene(): THREE.Group {
  const scene = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  mockCollada.material = material;
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.position.set(0.5, 0.25, 0);
  scene.add(mesh);
  return scene;
}

function translation(x: number, y: number, z: number): Transform {
  return new Transform([x, y, z], [0, 0, 0, 1]);
}

function setup({
  robots,
  urdf = primitiveUrdf,
  scales,
  fallbackColors,
}: {
  robots: number;
  urdf?: string;
  scales?: (number | undefined)[];
  fallbackColors?: (string | undefined)[];
}) {
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith(".urdf")) {
      return { data: new TextEncoder().encode(urdf), mediaType: "application/xml" };
    }
    if (url.endsWith(".dae")) {
      return { data: new TextEncoder().encode("<COLLADA/>"), mediaType: "model/vnd.collada+xml" };
    }
    if (url.endsWith(".stl")) {
      return { data: new Uint8Array(16), mediaType: "model/stl" };
    }
    throw new Error(`Unowned asset ${url}`);
  });
  const transformTree = new TransformTree(new ObjectPool(Transform.Empty));
  const modelCache = new ModelCache({
    fetchAsset,
    edgeMaterial: new THREE.MeshBasicMaterial(),
    ignoreColladaUpAxis: true,
    meshUpAxis: "z_up",
  });
  const layers: Record<string, unknown> = {};
  for (let i = 1; i <= robots; i++) {
    layers[`robot${i}`] = {
      layerId: "foxglove.Urdf",
      sourceType: "url",
      url: "https://models.invalid/robot.urdf",
      label: `Robot ${i}`,
      framePrefix: `r${i}/`,
      scale: scales?.[i - 1],
      fallbackColor: fallbackColors?.[i - 1],
    };
  }
  const config = {
    followTf: undefined,
    followMode: "follow-pose",
    layers,
    topics: {},
  };
  const renderer = {
    fixedFrameId: "world",
    fetchAsset,
    modelCache,
    transformTree,
    sharedGeometry: new SharedGeometry(),
    outlineMaterial: new THREE.LineBasicMaterial({ dithering: true }),
    instancedOutlineMaterial: new InstancedLineMaterial({ dithering: true }),
    maxLod: DetailLevel.High,
    on: jest.fn(),
    addCustomLayerAction: jest.fn(),
    config,
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
    updateConfig: jest.fn((updater: (draft: typeof config) => void) => {
      updater(config);
    }),
    updateCustomLayersCount: jest.fn(),
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
  return { extension, renderer, transformTree, modelCache };
}

function robot(extension: Urdfs, instanceId: string): UrdfRenderable {
  const renderable = extension.renderables.get(instanceId);
  if (!renderable) {
    throw new Error(`No robot ${instanceId}`);
  }
  return renderable;
}

function staticLink(extension: Urdfs, instanceId: string, frameId: string): StaticLinkState {
  const link = robot(extension, instanceId).userData.instancing?.staticLinks.find(
    (candidate) => candidate.frameId === frameId,
  );
  if (!link) {
    throw new Error(`No pooled static link ${frameId} on ${instanceId}`);
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

function slotPosition(slot: PoolSlot): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixPosition(slotWorldMatrix(slot));
}

function slotScale(slot: PoolSlot): THREE.Vector3 {
  const matrix = slotWorldMatrix(slot);
  return new THREE.Vector3().setFromMatrixScale(matrix);
}

function slotColor(slot: PoolSlot): [number, number, number] {
  const array = slot.batch.instancedMesh().instanceColor!.array as Float32Array;
  return [array[slot.index * 3]!, array[slot.index * 3 + 1]!, array[slot.index * 3 + 2]!];
}

function linearColor(r: number, g: number, b: number): THREE.Color {
  return rgbToThreeColor(new THREE.Color(), { r, g, b });
}

function expectColor(slot: PoolSlot, r: number, g: number, b: number): void {
  const expected = linearColor(r, g, b);
  const [red, green, blue] = slotColor(slot);
  expect(red).toBeCloseTo(expected.r);
  expect(green).toBeCloseTo(expected.g);
  expect(blue).toBeCloseTo(expected.b);
}

/**
 * Truth for one pooled visual, composed straight from the transform tree with
 * the legacy scaled composition. Every test URDF here has identity visual
 * orientations.
 */
function expectedSlotPose(
  transformTree: TransformTree,
  rootFrameId: string,
  linkFrameId: string,
  origin: Vector3,
  scale: number,
  time: bigint,
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const root = makePose();
  expect(
    transformTree.apply(root, makePose(), "world", "world", rootFrameId, time, time),
  ).toBeDefined();
  const rel = makePose();
  expect(
    transformTree.apply(rel, makePose(), rootFrameId, rootFrameId, linkFrameId, time, time),
  ).toBeDefined();
  const rootQuat = new THREE.Quaternion(
    root.orientation.x,
    root.orientation.y,
    root.orientation.z,
    root.orientation.w,
  );
  const quaternion = rootQuat
    .clone()
    .multiply(
      new THREE.Quaternion(rel.orientation.x, rel.orientation.y, rel.orientation.z, rel.orientation.w),
    );
  const position = new THREE.Vector3(
    rel.position.x * scale,
    rel.position.y * scale,
    rel.position.z * scale,
  )
    .applyQuaternion(rootQuat)
    .add(new THREE.Vector3(root.position.x, root.position.y, root.position.z))
    .add(new THREE.Vector3(origin.x * scale, origin.y * scale, origin.z * scale).applyQuaternion(quaternion));
  return { position, quaternion };
}

function expectSlotPose(
  transformTree: TransformTree,
  slot: PoolSlot,
  rootFrameId: string,
  linkFrameId: string,
  origin: Vector3,
  scale: number,
  time: bigint,
): void {
  const expected = expectedSlotPose(transformTree, rootFrameId, linkFrameId, origin, scale, time);
  const position = slotPosition(slot);
  expect(position.x).toBeCloseTo(expected.position.x);
  expect(position.y).toBeCloseTo(expected.position.y);
  expect(position.z).toBeCloseTo(expected.position.z);
}

function selectedRenderableHandler(renderer: { on: jest.Mock }): (selection: unknown) => void {
  const call = renderer.on.mock.calls.find(([name]) => name === "selectedRenderable") as
    | [string, (selection: unknown) => void]
    | undefined;
  if (call == undefined) {
    throw new Error("Urdfs did not subscribe to selectedRenderable");
  }
  return call[1];
}

/** Mirror Renderer.selectObject()/deselectObject() layer flips. */
function flipLayers(object: THREE.Object3D, layer: number): void {
  object.traverse((child) => {
    child.layers.set(layer);
  });
}

function deleteLayer(extension: Urdfs, instanceId: string): void {
  const entry = extension
    .settingsNodes()
    .find((candidate) => candidate.path[0] === "layers" && candidate.path[1] === instanceId);
  if (!entry?.node.handler) {
    throw new Error(`No settings entry for layer ${instanceId}`);
  }
  entry.node.handler({
    action: "perform-node-action",
    payload: { path: ["layers", instanceId], id: "delete" },
  });
}

const ORIGIN_IDENTITY: Vector3 = { x: 0, y: 0, z: 0 };
const ARM_ORIGIN: Vector3 = { x: 0.1, y: 0, z: 0 };

describe("Urdfs same-model instancing", () => {
  it("draws N same-model robots with O(parts) instanced meshes", async () => {
    const { extension, transformTree, modelCache } = setup({ robots: 3 });
    await extension.settleVideoDecodes();
    for (let i = 1; i <= 3; i++) {
      transformTree.addTransform(`r${i}/base_link`, "world", 0n, translation(i * 10, 0, 0));
    }

    // One shared box batch for every robot's static base+arm visuals; the
    // articulated rotor links keep their own per-link renderables.
    const batches = extension.instancePool.batches();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.instancedMesh().count).toBe(6);
    expect(batches[0]!.allocatedCount()).toBe(6);
    for (let i = 1; i <= 3; i++) {
      const renderables = robot(extension, `robot${i}`).userData.renderables;
      expect(renderables.size).toBe(1);
      expect([...renderables.values()][0]!.userData.frameId).toBe(`r${i}/rotor_link`);
    }

    extension.startFrame(100n, "world", "world");
    expect(batches[0]!.instancedMesh().visible).toBe(true);
    for (let i = 1; i <= 3; i++) {
      expectSlotPose(
        transformTree,
        staticLink(extension, `robot${i}`, `r${i}/base_link`).visuals[0]!.slots[0]!,
        `r${i}/base_link`,
        `r${i}/base_link`,
        ORIGIN_IDENTITY,
        1,
        100n,
      );
      expectSlotPose(
        transformTree,
        staticLink(extension, `robot${i}`, `r${i}/arm_link`).visuals[0]!.slots[0]!,
        `r${i}/base_link`,
        `r${i}/arm_link`,
        ARM_ORIGIN,
        1,
        100n,
      );
    }

    extension.dispose();
    modelCache.dispose();
  });

  it("rewrites instance matrices only when the root pose or link chain changes", async () => {
    const { extension, transformTree, modelCache } = setup({ robots: 2 });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));
    const batch = extension.instancePool.batches()[0]!;

    const applySpy = jest.spyOn(transformTree, "apply");
    extension.startFrame(100n, "world", "world");
    const matrixVersion = batch.instancedMesh().instanceMatrix.version;

    // Unchanged TF: no tree apply calls and no matrix buffer uploads.
    applySpy.mockClear();
    extension.startFrame(200n, "world", "world");
    expect(applySpy).not.toHaveBeenCalled();
    expect(batch.instancedMesh().instanceMatrix.version).toBe(matrixVersion);

    // A root move rewrites that robot's instances, rebasing the batch origin
    // near the data (x=1000 snaps onto the 64m grid).
    transformTree.addTransform("r1/base_link", "world", 300n, translation(1000, 0, 0));
    extension.startFrame(300n, "world", "world");
    expect(batch.instancedMesh().instanceMatrix.version).toBeGreaterThan(matrixVersion);
    expect(batch.position.x).toBe(1024);
    expectSlotPose(
      transformTree,
      staticLink(extension, "robot1", "r1/arm_link").visuals[0]!.slots[0]!,
      "r1/base_link",
      "r1/arm_link",
      ARM_ORIGIN,
      1,
      300n,
    );

    extension.dispose();
    modelCache.dispose();
  });

  it("keeps articulated links on per-link renderables that follow joint TF", async () => {
    const { extension, transformTree, modelCache } = setup({ robots: 2 });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));

    extension.startFrame(100n, "world", "world");
    const rotor1 = [...robot(extension, "robot1").userData.renderables.values()][0]!;
    expect(rotor1.userData.frameId).toBe("r1/rotor_link");
    expect(rotor1.position.x).toBeCloseTo(11);

    // The rotor swings out; only its own renderable moves.
    transformTree.addTransform("r1/rotor_link", "r1/arm_link", 200n, translation(0, 2, 0));
    extension.startFrame(300n, "world", "world");
    expect(rotor1.position.x).toBeCloseTo(11);
    expect(rotor1.position.y).toBeCloseTo(2);
    const rotor2 = [...robot(extension, "robot2").userData.renderables.values()][0]!;
    // The untouched robot's rotor still rides its arm at y+1.
    expect(rotor2.position.y).toBeCloseTo(1);

    extension.dispose();
    modelCache.dispose();
  });

  it("lands link colors and per-robot fallback colors in instanceColor", async () => {
    const { extension, transformTree, modelCache } = setup({
      robots: 2,
      fallbackColors: ["#00ff00", "#0000ff"],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));
    extension.startFrame(100n, "world", "world");

    // The link material color wins over the fallback; the fallback differs per
    // robot inside the same batch.
    expectColor(staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots[0]!, 1, 0, 0);
    expectColor(staticLink(extension, "robot1", "r1/arm_link").visuals[0]!.slots[0]!, 0, 1, 0);
    expectColor(staticLink(extension, "robot2", "r2/base_link").visuals[0]!.slots[0]!, 1, 0, 0);
    expectColor(staticLink(extension, "robot2", "r2/arm_link").visuals[0]!.slots[0]!, 0, 0, 1);

    extension.dispose();
    modelCache.dispose();
  });

  it("moves a selected robot to the legacy path and back with the highlight intact", async () => {
    const { extension, renderer, transformTree, modelCache } = setup({ robots: 3 });
    await extension.settleVideoDecodes();
    for (let i = 1; i <= 3; i++) {
      transformTree.addTransform(`r${i}/base_link`, "world", 0n, translation(i * 10, 0, 0));
    }
    extension.startFrame(100n, "world", "world");
    const batch = extension.instancePool.batches()[0]!;
    expect(batch.allocatedCount()).toBe(6);

    // Renderer.setSelectedRenderable flips layers before emitting; mirror that.
    const selected = robot(extension, "robot2");
    flipLayers(selected, 1);
    selectedRenderableHandler(renderer)({ renderable: selected });
    extension.startFrame(101n, "world", "world");

    // The selected robot's static links render per-link with the selection
    // layers, and its pool slots are freed.
    expect(batch.allocatedCount()).toBe(4);
    const children = [...selected.userData.renderables.values()];
    expect(children.map((child) => child.userData.frameId)).toEqual([
      "r2/rotor_link",
      "r2/base_link",
      "r2/arm_link",
    ]);
    for (const child of children) {
      expect(child.layers.mask).toBe(2);
      child.traverse((object) => {
        expect(object.layers.mask).toBe(2);
      });
    }
    const baseChild = children.find((child) => child.userData.frameId === "r2/base_link")!;
    expect(baseChild.position.x).toBeCloseTo(20);
    const armChild = children.find((child) => child.userData.frameId === "r2/arm_link")!;
    expect(armChild.position.x).toBeCloseTo(21.1);
    expect(staticLink(extension, "robot2", "r2/base_link").visuals[0]!.slots).toHaveLength(0);

    // Deselect: back into the pool, slots reassigned, matrices rewritten.
    flipLayers(selected, 0);
    selectedRenderableHandler(renderer)(undefined);
    extension.startFrame(102n, "world", "world");
    expect(batch.allocatedCount()).toBe(6);
    expect([...selected.userData.renderables.values()].map((child) => child.userData.frameId)).toEqual([
      "r2/rotor_link",
    ]);
    expectSlotPose(
      transformTree,
      staticLink(extension, "robot2", "r2/arm_link").visuals[0]!.slots[0]!,
      "r2/base_link",
      "r2/arm_link",
      ARM_ORIGIN,
      1,
      102n,
    );

    extension.dispose();
    modelCache.dispose();
  });

  it("maps picked instances back to their owning robot", async () => {
    const { extension, transformTree, modelCache } = setup({ robots: 2 });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));
    extension.startFrame(100n, "world", "world");

    const batch = extension.instancePool.batches()[0]!;
    const armSlot = staticLink(extension, "robot2", "r2/arm_link").visuals[0]!.slots[0]!;
    expect(batch.instanceOwner(armSlot.index)).toBe(robot(extension, "robot2"));
    const baseSlot = staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots[0]!;
    expect(batch.instanceOwner(baseSlot.index)).toBe(robot(extension, "robot1"));
    // Holes and non-pool renderables report no owner (Renderer keeps the
    // picked renderable in that case).
    expect(robot(extension, "robot1").instanceOwner(3)).toBeUndefined();
    deleteLayer(extension, "robot2");
    expect(batch.instanceOwner(armSlot.index)).toBeUndefined();

    extension.dispose();
    modelCache.dispose();
  });

  it("batches robots with different layer scales together by folding scale into matrices", async () => {
    const { extension, transformTree, modelCache } = setup({
      robots: 2,
      scales: [1, 2],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));

    const batches = extension.instancePool.batches();
    expect(batches).toHaveLength(1);
    extension.startFrame(100n, "world", "world");

    const arm1 = staticLink(extension, "robot1", "r1/arm_link").visuals[0]!;
    expectSlotPose(transformTree, arm1.slots[0]!, "r1/base_link", "r1/arm_link", ARM_ORIGIN, 1, 100n);
    const scale1 = slotScale(arm1.slots[0]!);
    expect(scale1.x).toBeCloseTo(0.2);

    const arm2 = staticLink(extension, "robot2", "r2/arm_link").visuals[0]!;
    expectSlotPose(transformTree, arm2.slots[0]!, "r2/base_link", "r2/arm_link", ARM_ORIGIN, 2, 100n);
    const scale2 = slotScale(arm2.slots[0]!);
    expect(scale2.x).toBeCloseTo(0.4);
    // The scaled robot's arm rides at twice the root->link offset.
    expect(slotPosition(arm2.slots[0]!).x).toBeCloseTo(22.2);

    extension.dispose();
    modelCache.dispose();
  });

  it("splits transparent instances into their own batch with per-instance alpha", async () => {
    const { extension, transformTree, modelCache } = setup({
      robots: 1,
      fallbackColors: ["#00ff0080"],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    extension.startFrame(100n, "world", "world");

    const batches = extension.instancePool.batches();
    expect(batches).toHaveLength(2);
    const armSlot = staticLink(extension, "robot1", "r1/arm_link").visuals[0]!.slots[0]!;
    const baseSlot = staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots[0]!;
    expect(armSlot.batch).not.toBe(baseSlot.batch);

    const opaque = baseSlot.batch;
    expect((opaque.instancedMesh().material as THREE.MeshStandardMaterial).transparent).toBe(false);
    const alpha = armSlot.batch;
    const material = alpha.instancedMesh().material as THREE.MeshStandardMaterial;
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    // Transparent batches own a cloned geometry for the instanceOpacity
    // attribute; the shared unit geometry stays attribute-free.
    expect(alpha.instancedMesh().geometry).not.toBe(opaque.instancedMesh().geometry);
    const opacity = alpha.instancedMesh().geometry.getAttribute("instanceOpacity");
    expect(opacity).toBeDefined();
    expect(opacity.getX(armSlot.index)).toBeCloseTo(128 / 255);
    expect(opaque.instancedMesh().geometry.getAttribute("instanceOpacity")).toBeUndefined();
    expectColor(armSlot, 0, 1, 0);

    extension.dispose();
    modelCache.dispose();
  });

  it("instances embedded-material Collada leaves with one material clone per batch", async () => {
    const { extension, renderer, transformTree, modelCache } = setup({
      robots: 2,
      urdf: meshUrdf("wheel.dae"),
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));
    extension.startFrame(100n, "world", "world");

    const batches = extension.instancePool.batches();
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.instancedMesh().count).toBe(2);
    // Embedded materials are cloned once per batch, not per robot, and the
    // URDF/marker color does not apply to them.
    expect(batch.instancedMesh().material).not.toBe(mockCollada.material);
    expect(batch.instancedMesh().material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(batch.instancedMesh().instanceColor).toBeNull();
    // The model fetched once; both robots share the cached leaves.
    expect(
      renderer.fetchAsset.mock.calls.filter(([url]) => (url as string).endsWith(".dae")),
    ).toHaveLength(1);
    // The leaf's local offset lands in both instance matrices.
    expect(slotPosition(staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots[0]!).x).toBeCloseTo(10.5);
    expect(slotPosition(staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots[0]!).y).toBeCloseTo(0.25);
    expect(slotPosition(staticLink(extension, "robot2", "r2/base_link").visuals[0]!.slots[0]!).x).toBeCloseTo(20.5);

    extension.dispose();
    modelCache.dispose();
  });

  it("instances non-embedded mesh leaves with shared geometry and baked colors", async () => {
    const { extension, renderer, transformTree, modelCache } = setup({
      robots: 2,
      urdf: meshUrdf("wheel.stl"),
      fallbackColors: ["#00ff00", "#00ff00"],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));
    extension.startFrame(100n, "world", "world");

    const batches = extension.instancePool.batches();
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.instancedMesh().count).toBe(2);
    expect(batch.instancedMesh().geometry).toBe(mockStl.geometry);
    expect(batch.instancedMesh().material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(
      renderer.fetchAsset.mock.calls.filter(([url]) => (url as string).endsWith(".stl")),
    ).toHaveLength(1);
    expectColor(staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots[0]!, 0, 1, 0);
    expect(slotPosition(staticLink(extension, "robot2", "r2/base_link").visuals[0]!.slots[0]!).x).toBeCloseTo(20);

    extension.dispose();
    modelCache.dispose();
  });

  it("falls back to the legacy path for a static link reparented outside the robot root", async () => {
    const { extension, transformTree, modelCache } = setup({ robots: 1 });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    extension.startFrame(100n, "world", "world");
    const batch = extension.instancePool.batches()[0]!;
    expect(batch.allocatedCount()).toBe(2);

    // arm_link is reparented straight onto the world frame: the hoisted root
    // pose can no longer decompose it, so the link follows TF per-link.
    transformTree.addTransform("r1/arm_link", "world", 200n, translation(50, 0, 0));
    extension.startFrame(300n, "world", "world");
    expect(batch.allocatedCount()).toBe(1);
    const renderable = robot(extension, "robot1");
    const armChild = [...renderable.userData.renderables.values()].find(
      (child) => child.userData.frameId === "r1/arm_link",
    )!;
    expect(armChild).toBeDefined();
    expect(armChild.position.x).toBeCloseTo(50.1);
    expect(staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots).toHaveLength(1);

    // Reparented back under the robot root, the link returns to the pool.
    transformTree.addTransform("r1/arm_link", "r1/base_link", 400n, translation(1, 0, 0));
    extension.startFrame(500n, "world", "world");
    expect(batch.allocatedCount()).toBe(2);
    expect(
      [...renderable.userData.renderables.values()].filter(
        (child) => child.userData.frameId === "r1/arm_link",
      ),
    ).toHaveLength(0);
    expectSlotPose(
      transformTree,
      staticLink(extension, "robot1", "r1/arm_link").visuals[0]!.slots[0]!,
      "r1/base_link",
      "r1/arm_link",
      ARM_ORIGIN,
      1,
      500n,
    );

    extension.dispose();
    modelCache.dispose();
  });

  it("hides and restores pooled instances synchronously with robot visibility", async () => {
    const { extension, transformTree, modelCache } = setup({ robots: 2 });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));
    extension.startFrame(100n, "world", "world");
    const batch = extension.instancePool.batches()[0]!;
    const baseSlot = staticLink(extension, "robot1", "r1/base_link").visuals[0]!.slots[0]!;
    expect(slotScale(baseSlot).x).toBeCloseTo(0.1);

    // Pick loops hide renderables between frames; the pool follows without a
    // startFrame in between.
    robot(extension, "robot1").visible = false;
    expect(slotScale(baseSlot).x).toBe(0);
    expect(batch.instancedMesh().visible).toBe(true); // robot2 still draws

    robot(extension, "robot1").visible = true;
    extension.startFrame(200n, "world", "world");
    expectSlotPose(transformTree, baseSlot, "r1/base_link", "r1/base_link", ORIGIN_IDENTITY, 1, 200n);

    extension.dispose();
    modelCache.dispose();
  });

  it("releases instances on layer removal and disposes empty batches", async () => {
    const { extension, transformTree, modelCache } = setup({ robots: 3 });
    await extension.settleVideoDecodes();
    for (let i = 1; i <= 3; i++) {
      transformTree.addTransform(`r${i}/base_link`, "world", 0n, translation(i * 10, 0, 0));
    }
    extension.startFrame(100n, "world", "world");
    const batch = extension.instancePool.batches()[0]!;
    expect(batch.allocatedCount()).toBe(6);

    deleteLayer(extension, "robot2");
    extension.startFrame(200n, "world", "world");
    expect(batch.allocatedCount()).toBe(4);
    expect(extension.renderables.has("robot2")).toBe(false);

    // The remaining slots keep their exact poses after the removal.
    expectSlotPose(
      transformTree,
      staticLink(extension, "robot3", "r3/arm_link").visuals[0]!.slots[0]!,
      "r3/base_link",
      "r3/arm_link",
      ARM_ORIGIN,
      1,
      200n,
    );

    deleteLayer(extension, "robot1");
    deleteLayer(extension, "robot3");
    extension.startFrame(300n, "world", "world");
    expect(extension.instancePool.batches()).toHaveLength(0);
    expect(extension.children.filter((child) => child instanceof THREE.InstancedMesh)).toHaveLength(0);

    extension.dispose();
    modelCache.dispose();
  });
});
