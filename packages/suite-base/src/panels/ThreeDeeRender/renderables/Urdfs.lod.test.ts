/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { ObjectPool } from "@lichtblick/den/collection";

import { PoolSlot, StaticLinkState } from "./UrdfInstancePool";
import { LayerSettingsCustomUrdf, Urdfs, UrdfRenderable } from "./Urdfs";
import type { IRenderer } from "../IRenderer";
import { InstancedLineMaterial } from "../IRenderer";
import { ModelCache } from "../ModelCache";
import { SharedGeometry } from "../SharedGeometry";
import { DetailLevel } from "../lod";
import { RenderableMeshResource } from "./markers/RenderableMeshResource";
import { Transform } from "../transforms/Transform";
import { TransformTree } from "../transforms/TransformTree";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "draco.wasm");
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "");
jest.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/ColladaLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/STLLoader.js", () => ({
  STLLoader: class {
    public parse() {
      const THREEActual = jest.requireActual<typeof import("three")>("three");
      return new THREEActual.BufferGeometry();
    }
  },
}));

const URL_BASE = "https://models.invalid/urdf/scout_visual.urdf";
const URL_HIGH = "https://models.invalid/urdf/scout_visual_lod10k.urdf";
const URL_MEDIUM = "https://models.invalid/urdf/scout_visual_lod_medium.urdf";
const URL_LOW = "https://models.invalid/urdf/scout_visual_lod1500.urdf";

// base_link (static mesh visual) --(continuous)--> rotor_link (articulated box).
// Tier URDFs differ ONLY in the visual mesh URI, per the asset contract.
function tierUrdf(mesh: string): string {
  return `<robot name="scout">
  <link name="base_link">
    <visual><geometry><mesh filename="${mesh}"/></geometry></visual>
  </link>
  <link name="rotor_link">
    <visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual>
  </link>
  <joint name="base_to_rotor" type="continuous">
    <parent link="base_link"/><child link="rotor_link"/>
    <origin xyz="0 0 0.2"/>
  </joint>
</robot>`;
}

const URL_URDFS: Record<string, string> = {
  [URL_BASE]: tierUrdf("wheel_lod10k.stl"),
  [URL_HIGH]: tierUrdf("wheel_lod10k.stl"),
  [URL_MEDIUM]: tierUrdf("wheel_lod_medium.stl"),
  [URL_LOW]: tierUrdf("wheel_lod1500.stl"),
};

const PKG_PREFIX = "package://scout_description";
const PKG_URDFS: Record<string, string> = {
  [`${PKG_PREFIX}/urdf/scout_visual_lod10k.urdf`]: tierUrdf(`${PKG_PREFIX}/meshes/wheel_lod10k.stl`),
  [`${PKG_PREFIX}/urdf/scout_visual_lod_medium.urdf`]: tierUrdf(
    `${PKG_PREFIX}/meshes/wheel_lod_medium.stl`,
  ),
  [`${PKG_PREFIX}/urdf/scout_visual_lod1500.urdf`]: tierUrdf(
    `${PKG_PREFIX}/meshes/wheel_lod1500.stl`,
  ),
};
const PARAM_MESH_URDF = tierUrdf(`${PKG_PREFIX}/meshes/wheel_lod10k.stl`);
const PARAM_PRIMITIVE_URDF = `<robot name="prim">
  <link name="base_link">
    <visual><geometry><box size="0.5 0.5 0.5"/></geometry></visual>
  </link>
</robot>`;

// The model bounding radius is 0.866 (unit-scale mesh extent), the viewport is
// 1000px and the camera fov is 60°, so the projected size is exactly 1500/d px.
function translation(x: number, y: number, z: number): Transform {
  return new Transform([x, y, z], [0, 0, 0, 1]);
}

type RobotSpec = { id: string; prefix: string; x: number; lod?: "auto" | "high" | "medium" | "low" };

function setup({
  robots,
  withCamera = true,
  parameterContent,
}: {
  robots: RobotSpec[];
  withCamera?: boolean;
  parameterContent?: string;
}) {
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
    const urdf = URL_URDFS[url] ?? PKG_URDFS[url];
    if (urdf != undefined) {
      return { data: new TextEncoder().encode(urdf), mediaType: "application/xml" };
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
  for (const spec of robots) {
    layers[spec.id] = parameterContent
      ? {
          layerId: "foxglove.Urdf",
          sourceType: "param",
          parameter: "robot_description",
          label: spec.id,
          framePrefix: spec.prefix,
          lod: spec.lod,
        }
      : {
          layerId: "foxglove.Urdf",
          sourceType: "url",
          url: URL_BASE,
          label: spec.id,
          framePrefix: spec.prefix,
          lod: spec.lod,
        };
  }
  const config = {
    followTf: undefined,
    followMode: "follow-pose",
    layers,
    topics: {},
  };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10000);
  const parameters = parameterContent
    ? new Map<string, unknown>([["robot_description", parameterContent]])
    : undefined;
  const renderer = {
    fixedFrameId: "world",
    fetchAsset,
    modelCache,
    transformTree,
    parameters,
    sharedGeometry: new SharedGeometry(),
    outlineMaterial: new THREE.LineBasicMaterial({ dithering: true }),
    instancedOutlineMaterial: new InstancedLineMaterial({ dithering: true }),
    maxLod: DetailLevel.High,
    on: jest.fn(),
    addCustomLayerAction: jest.fn(),
    config,
    cameraHandler: withCamera ? { getActiveCamera: () => camera } : undefined,
    input: withCamera ? { canvasSize: new THREE.Vector2(1000, 1000) } : undefined,
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
  return { extension, renderer, transformTree, modelCache, camera };
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

function meshSlot(extension: Urdfs, instanceId: string, frameId: string): PoolSlot {
  const slot = staticLink(extension, instanceId, frameId).visuals[0]?.slots[0];
  if (!slot) {
    throw new Error(`No pooled mesh slot for ${frameId} on ${instanceId}`);
  }
  return slot;
}

/** Rebase-origin-independent world position of one pooled instance. */
function slotPosition(slot: PoolSlot): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  slot.batch.instancedMesh().getMatrixAt(slot.index, matrix);
  matrix.elements[12]! += slot.batch.position.x;
  matrix.elements[13]! += slot.batch.position.y;
  matrix.elements[14]! += slot.batch.position.z;
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

function meshBatchNames(extension: Urdfs): string[] {
  return extension.instancePool
    .batches()
    .map((batch) => batch.name)
    .filter((name) => name.startsWith("mesh:"));
}

function meshResource(extension: Urdfs, instanceId: string, frameId: string): string {
  const child = [...robot(extension, instanceId).userData.renderables.values()].find(
    (candidate) => candidate.userData.frameId === frameId,
  );
  if (!(child instanceof RenderableMeshResource)) {
    throw new Error(`No legacy mesh child for ${frameId} on ${instanceId}`);
  }
  return child.userData.marker.mesh_resource;
}

function urdfFetches(fetchAsset: jest.Mock, url: string): number {
  return fetchAsset.mock.calls.filter(([candidate]) => candidate === url).length;
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

function parametersChangeHandler(
  renderer: { on: jest.Mock },
): (parameters: ReadonlyMap<string, unknown>) => void {
  const call = renderer.on.mock.calls.find(([name]) => name === "parametersChange") as
    | [string, (parameters: ReadonlyMap<string, unknown>) => void]
    | undefined;
  if (call == undefined) {
    throw new Error("Urdfs did not subscribe to parametersChange");
  }
  return call[1];
}

function flipLayers(object: THREE.Object3D, layer: number): void {
  object.traverse((child) => {
    child.layers.set(layer);
  });
}

function setLayerLod(
  renderer: { config: { layers: Record<string, unknown> } },
  instanceId: string,
  lod: string,
): void {
  (renderer.config.layers[instanceId] as Partial<LayerSettingsCustomUrdf>).lod =
    lod as LayerSettingsCustomUrdf["lod"];
}

describe("Urdfs screen-size LOD", () => {
  it("exposes the per-layer LOD select with auto as the default", async () => {
    const { extension, modelCache } = setup({ robots: [{ id: "robot1", prefix: "r1/", x: 10 }] });
    await extension.settleVideoDecodes();
    const entry = extension
      .settingsNodes()
      .find((candidate) => candidate.path[0] === "layers" && candidate.path[1] === "robot1");
    expect(entry?.node.fields?.lod).toMatchObject({
      input: "select",
      value: "auto",
      options: [
        { label: "Auto", value: "auto" },
        { label: "High", value: "high" },
        { label: "Medium", value: "medium" },
        { label: "Low", value: "low" },
      ],
    });
    extension.dispose();
    modelCache.dispose();
  });

  it("holds the default high tier for large robots without fetching tiers", async () => {
    const { extension, renderer, transformTree, modelCache, camera } = setup({
      robots: [{ id: "robot1", prefix: "r1/", x: 10 }],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    camera.position.set(8, 0, 0); // d=2 → 750px, deep in the high band

    extension.startFrame(100n, "world", "world");
    await extension.settleVideoDecodes();

    expect(urdfFetches(renderer.fetchAsset, URL_MEDIUM)).toBe(0);
    expect(urdfFetches(renderer.fetchAsset, URL_LOW)).toBe(0);
    expect(urdfFetches(renderer.fetchAsset, URL_HIGH)).toBe(0);
    expect(meshBatchNames(extension).some((name) => name.includes("wheel_lod10k.stl"))).toBe(true);
    expect(slotPosition(meshSlot(extension, "robot1", "r1/base_link")).x).toBeCloseTo(10);

    extension.dispose();
    modelCache.dispose();
  });

  it("swaps tiers by projected size with hysteresis and caches tier parses", async () => {
    const { extension, renderer, transformTree, modelCache, camera } = setup({
      robots: [{ id: "robot1", prefix: "r1/", x: 10 }],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    const frame = async (time: bigint) => {
      extension.startFrame(time, "world", "world");
      await extension.settleVideoDecodes();
      extension.startFrame(time + 1n, "world", "world");
      await extension.settleVideoDecodes();
    };

    // 500px: inside the 435–589px hysteresis band, high holds.
    camera.position.set(7, 0, 0);
    await frame(100n);
    expect(urdfFetches(renderer.fetchAsset, URL_MEDIUM)).toBe(0);
    expect(meshBatchNames(extension).some((name) => name.includes("wheel_lod10k.stl"))).toBe(true);

    // 417px: clearly below the band, swap down to medium.
    camera.position.set(6.4, 0, 0);
    await frame(200n);
    expect(urdfFetches(renderer.fetchAsset, URL_MEDIUM)).toBe(1);
    expect(meshBatchNames(extension)).toHaveLength(1);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod_medium.stl");

    // 441px: back inside the band, medium holds — no swap, no fetch.
    camera.position.set(6.6, 0, 0);
    await frame(300n);
    expect(urdfFetches(renderer.fetchAsset, URL_MEDIUM)).toBe(1);
    expect(urdfFetches(renderer.fetchAsset, URL_HIGH)).toBe(0);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod_medium.stl");

    // 75px: swap down to low.
    camera.position.set(-10, 0, 0);
    await frame(400n);
    expect(urdfFetches(renderer.fetchAsset, URL_LOW)).toBe(1);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod1500.stl");

    // 115px: inside the 109–147px band, low holds.
    camera.position.set(-3, 0, 0);
    await frame(500n);
    expect(urdfFetches(renderer.fetchAsset, URL_LOW)).toBe(1);
    expect(urdfFetches(renderer.fetchAsset, URL_MEDIUM)).toBe(1);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod1500.stl");

    // 150px: back up to medium, served from the tier cache.
    camera.position.set(0, 0, 0);
    await frame(600n);
    expect(urdfFetches(renderer.fetchAsset, URL_MEDIUM)).toBe(1);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod_medium.stl");

    // 750px: back up to high, served from the just-loaded default model —
    // neither the tier URL nor the default URL is fetched again.
    camera.position.set(8, 0, 0);
    await frame(700n);
    expect(urdfFetches(renderer.fetchAsset, URL_HIGH)).toBe(0);
    expect(urdfFetches(renderer.fetchAsset, URL_BASE)).toBe(1);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod10k.stl");

    // Poses come from the same root feed across every swap.
    expect(slotPosition(meshSlot(extension, "robot1", "r1/base_link")).x).toBeCloseTo(10);
    expect(slotPosition(meshSlot(extension, "robot1", "r1/base_link")).y).toBeCloseTo(0);

    extension.dispose();
    modelCache.dispose();
  });

  it("honors pinned tiers without a camera and splits batches per tier", async () => {
    const { extension, renderer, transformTree, modelCache } = setup({
      withCamera: false,
      robots: [
        { id: "robot1", prefix: "r1/", x: 10, lod: "medium" },
        { id: "robot2", prefix: "r2/", x: 20, lod: "high" },
      ],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    transformTree.addTransform("r2/base_link", "world", 0n, translation(20, 0, 0));

    extension.startFrame(100n, "world", "world");
    await extension.settleVideoDecodes();
    extension.startFrame(101n, "world", "world");
    await extension.settleVideoDecodes();

    // robot1 pinned medium swapped without any camera; robot2 pinned high
    // never fetched a tier. Two robots on different tiers do NOT share a batch.
    expect(urdfFetches(renderer.fetchAsset, URL_MEDIUM)).toBe(1);
    expect(urdfFetches(renderer.fetchAsset, URL_LOW)).toBe(0);
    expect(urdfFetches(renderer.fetchAsset, URL_HIGH)).toBe(0);
    const splitBatches = meshBatchNames(extension);
    expect(splitBatches).toHaveLength(2);
    expect(splitBatches.some((name) => name.includes("wheel_lod_medium.stl"))).toBe(true);
    expect(splitBatches.some((name) => name.includes("wheel_lod10k.stl"))).toBe(true);
    for (const batch of extension.instancePool.batches()) {
      expect(batch.allocatedCount()).toBe(1);
    }

    // Same-tier robots share one batch again.
    setLayerLod(renderer, "robot1", "low");
    setLayerLod(renderer, "robot2", "low");
    extension.startFrame(200n, "world", "world");
    await extension.settleVideoDecodes();
    extension.startFrame(201n, "world", "world");
    await extension.settleVideoDecodes();
    const sharedBatches = meshBatchNames(extension);
    expect(sharedBatches).toHaveLength(1);
    expect(sharedBatches[0]).toContain("wheel_lod1500.stl");
    expect(extension.instancePool.batches()[0]!.allocatedCount()).toBe(2);
    expect(slotPosition(meshSlot(extension, "robot1", "r1/base_link")).x).toBeCloseTo(10);
    expect(slotPosition(meshSlot(extension, "robot2", "r2/base_link")).x).toBeCloseTo(20);

    extension.dispose();
    modelCache.dispose();
  });

  it("swaps a selected robot's tier on the legacy per-link path", async () => {
    const { extension, renderer, transformTree, modelCache, camera } = setup({
      robots: [{ id: "robot1", prefix: "r1/", x: 10 }],
    });
    await extension.settleVideoDecodes();
    transformTree.addTransform("r1/base_link", "world", 0n, translation(10, 0, 0));
    camera.position.set(8, 0, 0);
    extension.startFrame(100n, "world", "world");

    // Select: the static mesh link migrates to a legacy per-link child.
    const selected = robot(extension, "robot1");
    flipLayers(selected, 1);
    selectedRenderableHandler(renderer)({ renderable: selected });
    extension.startFrame(101n, "world", "world");
    await extension.settleVideoDecodes();
    expect(meshResource(extension, "robot1", "r1/base_link")).toContain("wheel_lod10k.stl");
    const highChild = [...selected.userData.renderables.values()].find(
      (child) => child.userData.frameId === "r1/base_link",
    )!;
    expect(highChild.position.x).toBeCloseTo(10);

    // Zoom far out: auto swaps to low; the selected robot rebuilds its legacy
    // children from the low tier with unchanged poses.
    camera.position.set(-10, 0, 0);
    extension.startFrame(200n, "world", "world");
    await extension.settleVideoDecodes();
    extension.startFrame(201n, "world", "world");
    await extension.settleVideoDecodes();
    expect(meshResource(extension, "robot1", "r1/base_link")).toContain("wheel_lod1500.stl");
    const lowChild = [...selected.userData.renderables.values()].find(
      (child) => child.userData.frameId === "r1/base_link",
    )!;
    expect(lowChild.position.x).toBeCloseTo(10);
    const rotorChild = [...selected.userData.renderables.values()].find(
      (child) => child.userData.frameId === "r1/rotor_link",
    )!;
    expect(rotorChild.position.z).toBeCloseTo(0.2);

    // Deselect: back into the pool, in the low tier batch.
    flipLayers(selected, 0);
    selectedRenderableHandler(renderer)(undefined);
    extension.startFrame(300n, "world", "world");
    await extension.settleVideoDecodes();
    expect(
      [...selected.userData.renderables.values()].map((child) => child.userData.frameId),
    ).toEqual(["r1/rotor_link"]);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod1500.stl");
    expect(slotPosition(meshSlot(extension, "robot1", "r1/base_link")).x).toBeCloseTo(10);

    extension.dispose();
    modelCache.dispose();
  });

  it("derives package:// tier URDFs for parameter-sourced robots", async () => {
    const { extension, renderer, transformTree, modelCache, camera } = setup({
      robots: [{ id: "model", prefix: "p/", x: 10 }],
      parameterContent: PARAM_MESH_URDF,
    });
    parametersChangeHandler(renderer)(renderer.parameters!);
    await extension.settleVideoDecodes();
    transformTree.addTransform("p/base_link", "world", 0n, translation(10, 0, 0));

    camera.position.set(-10, 0, 0); // d=20 → 75px → low
    extension.startFrame(100n, "world", "world");
    await extension.settleVideoDecodes();
    extension.startFrame(101n, "world", "world");
    await extension.settleVideoDecodes();

    expect(urdfFetches(renderer.fetchAsset, `${PKG_PREFIX}/urdf/scout_visual_lod1500.urdf`)).toBe(1);
    expect(meshBatchNames(extension)[0]).toContain("wheel_lod1500.stl");
    expect(slotPosition(meshSlot(extension, "model", "p/base_link")).x).toBeCloseTo(10);

    extension.dispose();
    modelCache.dispose();
  });

  it("degrades to the default tier with a settings note when no tier base resolves", async () => {
    const { extension, renderer, transformTree, modelCache, camera } = setup({
      robots: [{ id: "model", prefix: "p/", x: 10 }],
      parameterContent: PARAM_PRIMITIVE_URDF,
    });
    parametersChangeHandler(renderer)(renderer.parameters!);
    await extension.settleVideoDecodes();
    transformTree.addTransform("p/base_link", "world", 0n, translation(10, 0, 0));

    // Auto mode, camera far out: no package:// base exists, so the robot keeps
    // the loaded default tier and reports the degradation once — no crash, no fetch.
    camera.position.set(-100, 0, 0);
    extension.startFrame(100n, "world", "world");
    await extension.settleVideoDecodes();
    expect(renderer.settings.errors.add).toHaveBeenCalledWith(
      ["layers", "model"],
      "UrdfLodTier",
      expect.stringContaining("default detail level"),
    );
    expect(renderer.fetchAsset.mock.calls.filter(([url]) => String(url).includes("_lod"))).toHaveLength(0);

    // A pinned tier with no resolvable base degrades the same way.
    setLayerLod(renderer, "model", "low");
    extension.startFrame(200n, "world", "world");
    await extension.settleVideoDecodes();
    expect(renderer.fetchAsset.mock.calls.filter(([url]) => String(url).includes("_lod"))).toHaveLength(0);

    extension.dispose();
    modelCache.dispose();
  });
});
