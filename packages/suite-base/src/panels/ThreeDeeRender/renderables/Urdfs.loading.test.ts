/** @jest-environment jsdom */
import { RenderableMeshResource } from "./markers/RenderableMeshResource";

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { setImmediate as nextTurn } from "timers";

import { Urdfs } from "./Urdfs";
import { MISSING_TRANSFORM } from "./transforms";
import type { IRenderer } from "../IRenderer";
import { ModelCache } from "../ModelCache";
import { ObjectPool } from "@lichtblick/den/collection";
import { Transform, TransformTree } from "../transforms";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "draco.wasm");
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "");
jest.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/STLLoader.js", () => ({}));
const mockParse = jest.fn((_manager: THREE.LoadingManager) => ({
  scene: new THREE.Group(),
}));
jest.mock("three/examples/jsm/loaders/ColladaLoader.js", () => ({
  ColladaLoader: class {
    public constructor(private mockManager: THREE.LoadingManager) {}
    public parse() {
      return mockParse(this.mockManager);
    }
  },
}));
const originalURL = globalThis.URL;
beforeAll(() => {
  globalThis.URL = class extends originalURL {
    public static override createObjectURL = jest.fn(() => "blob:urdf-texture");
    public static override revokeObjectURL = jest.fn();
  };
});
afterAll(() => {
  globalThis.URL = originalURL;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const urdf =
  '<robot name="test"><link name="base_link"><visual><geometry><mesh filename="wheel.dae"/></geometry></visual></link></robot>';
function asset(text: string, mediaType: string) {
  return { data: new TextEncoder().encode(text), mediaType };
}
function setup(
  urdfAsset = Promise.resolve(asset(urdf, "application/xml")),
  instanceId = "model",
  ownedAssets?: ReadonlyMap<string, ReturnType<typeof asset> | Promise<ReturnType<typeof asset>>>,
) {
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
    const owned = ownedAssets?.get(url);
    if (owned != undefined) return await owned;
    if (url.endsWith(".urdf")) {
      return await urdfAsset;
    }
    if (url.endsWith(".dae")) {
      return asset(
        "<COLLADA><library_images><image><init_from>wheel.png</init_from></image></library_images></COLLADA>",
        "model/vnd.collada+xml",
      );
    }
    if (url.endsWith(".png")) {
      return {
        data: new Uint8Array([137, 80, 78, 71]),
        mediaType: "image/png",
      };
    }
    throw new Error(`Unowned asset ${url}`);
  });
  const modelCache = new ModelCache({
    fetchAsset,
    edgeMaterial: new THREE.MeshBasicMaterial(),
    ignoreColladaUpAxis: false,
    meshUpAxis: "z_up",
  });
  const renderer = {
    fetchAsset,
    modelCache,
    on: jest.fn(),
    off: jest.fn(),
    addCustomLayerAction: jest.fn(),
    config: {
      layers: {
        [instanceId]: {
          layerId: "foxglove.Urdf",
          sourceType: "url",
          url: "https://models.invalid/robot.urdf",
          label: "Robot",
          framePrefix: "",
          scale: 1,
        },
      },
      topics: {},
    },
    settings: {
      setNodesForKey: jest.fn(),
      errors: {
        add: jest.fn(),
        remove: jest.fn(),
        hasError: jest.fn(() => false),
        clearPath: jest.fn(),
      },
    },
    updateConfig: jest.fn(),
    transformTree: new TransformTree(new ObjectPool(Transform.Empty)),
    addCoordinateFrame: jest.fn(),
    addTransform: jest.fn(),
    removeTransform: jest.fn(),
    normalizeFrameId: (frame: string) => frame,
    queueAnimationFrame: jest.fn(),
  };
  const extension = new Urdfs(renderer as unknown as IRenderer);
  return { extension, renderer, modelCache };
}

it("drains the real model and texture promise before an offline frame can settle", async () => {
  const decoding = deferred<THREE.LoadingManager>();
  mockParse.mockImplementationOnce((manager) => {
    manager.itemStart("texture");
    decoding.resolve(manager);
    return { scene: new THREE.Group() };
  });
  const { extension, modelCache } = setup();
  let settled = false;
  const ready = extension.settleVideoDecodes().then(() => {
    settled = true;
  });
  const manager = await decoding.promise;
  await new Promise<void>((resolve) => {
    nextTurn(resolve);
  });
  const owner = extension.renderables.get("model")!;
  const child = [...owner.pendingVisual!.userData.renderables.values()][0]!;
  expect(owner.userData.renderables.size).toBe(0);
  expect(settled).toBe(false);
  expect(child.children).toHaveLength(0);
  manager.itemEnd("texture");
  await ready;
  expect(child.children).toHaveLength(1);
  expect(extension.robotFollowFrames()).toEqual([{ label: "Robot", value: "base_link" }]);
  extension.dispose();
  modelCache.dispose();
});

it("settles a failed texture with an authoritative error, never a mesh", async () => {
  const decoding = deferred<THREE.LoadingManager>();
  mockParse.mockImplementationOnce((manager) => {
    manager.itemStart("texture");
    decoding.resolve(manager);
    return { scene: new THREE.Group() };
  });
  const { extension, renderer, modelCache } = setup();
  const ready = extension.settleVideoDecodes();
  const manager = await decoding.promise;
  manager.itemError("texture");
  manager.itemEnd("texture");
  await ready;
  expect(extension.renderables.get("model")!.userData.renderables.size).toBe(0);
  expect(extension.renderables.get("model")!.pendingVisual).toBeUndefined();
  expect(renderer.settings.errors.add).toHaveBeenCalledWith(
    ["layers", "model"],
    "MESH_FETCH_FAILED",
    expect.stringContaining("COLLADA"),
  );
  extension.dispose();
  modelCache.dispose();
});

it("does not recreate a removed layer after a late URDF fetch", async () => {
  const pending = deferred<ReturnType<typeof asset>>();
  const { extension, renderer, modelCache } = setup(pending.promise);
  extension.dispose();
  pending.resolve(asset(urdf, "application/xml"));
  await extension.settleVideoDecodes();
  expect(extension.renderables.size).toBe(0);
  expect(renderer.modelCache).toBe(modelCache);
  expect(renderer.fetchAsset).toHaveBeenCalledTimes(1);
  expect(renderer.settings.errors.add).not.toHaveBeenCalled();
  modelCache.dispose();
});

it("preserves parked URDFs on seek and reuses the cache after layer disposal", async () => {
  const decoding = deferred<THREE.LoadingManager>();
  mockParse.mockImplementationOnce((manager) => {
    manager.itemStart("texture");
    decoding.resolve(manager);
    return { scene: new THREE.Group() };
  });
  const { extension, renderer, modelCache } = setup();
  const manager = await decoding.promise;
  const removed = [
    ...extension.renderables.get("model")!.pendingVisual!.userData.renderables.values(),
  ][0]!;
  extension.removeAllRenderables();
  expect(extension.renderables.size).toBe(1);
  extension.dispose();
  const reloaded = new Urdfs(renderer as unknown as IRenderer);
  manager.itemEnd("texture");
  await Promise.all([extension.settleVideoDecodes(), reloaded.settleVideoDecodes()]);
  const current = [...reloaded.renderables.get("model")!.userData.renderables.values()][0]!;
  expect(removed.children).toHaveLength(0);
  expect(current.children).toHaveLength(1);
  expect(
    renderer.fetchAsset.mock.calls.filter(([url]) => (url as string).endsWith(".dae")),
  ).toHaveLength(1);
  extension.dispose();
  reloaded.dispose();
  modelCache.dispose();
});

it("reconciles managed config or restored membership once while pose work continues", async () => {
  const instanceId = "xgc2-urdf-test";
  const { extension, renderer, modelCache } = setup(undefined, instanceId);
  await extension.settleVideoDecodes();
  const layer = renderer.config.layers[instanceId]!;
  const readLayer = jest.fn(() => layer);
  Object.defineProperty(renderer.config.layers, instanceId, {
    configurable: true,
    enumerable: true,
    get: readLayer,
  });
  renderer.transformTree.addTransform(
    "base_link",
    "world",
    0n,
    new Transform([1, 0, 0], [0, 0, 0, 1]),
  );
  extension.startFrame(0n, "world", "world");
  const child = [...extension.renderables.get(instanceId)!.userData.renderables.values()][0]!;
  expect(child.position.x).toBeCloseTo(1);
  readLayer.mockClear();
  for (let frame = 1; frame <= 10; frame++) extension.startFrame(BigInt(frame), "world", "world");
  expect(readLayer).not.toHaveBeenCalled();
  renderer.transformTree.addTransform(
    "base_link",
    "world",
    11n,
    new Transform([2, 0, 0], [0, 0, 0, 1]),
  );
  extension.startFrame(11n, "world", "world");
  expect(child.position.x).toBeCloseTo(2);
  expect(readLayer).not.toHaveBeenCalled();
  extension.removeAllRenderables();
  extension.startFrame(12n, "world", "world");
  expect(readLayer).toHaveBeenCalled();
  readLayer.mockClear();
  extension.startFrame(13n, "world", "world");
  expect(readLayer).not.toHaveBeenCalled();

  const generation = extension.renderables.get(instanceId)!.loadGeneration;
  renderer.config.layers = {
    ...renderer.config.layers,
    [instanceId]: { ...layer, framePrefix: "next/", scale: 2 },
  };
  extension.startFrame(14n, "world", "world");
  await extension.settleVideoDecodes();
  expect(extension.renderables.get(instanceId)!.loadGeneration).toBeGreaterThan(generation);
  expect(extension.robotFollowFrames()[0]?.value).toBe("next/base_link");
  extension.startFrame(15n, "world", "world");
  const keys = jest.spyOn(extension.renderables, "keys");
  extension.startFrame(16n, "world", "world");
  expect(keys).not.toHaveBeenCalled();
  const disposed = jest.spyOn(extension.renderables.get(instanceId)!, "dispose");
  renderer.config.layers = {};
  extension.startFrame(17n, "world", "world");
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(extension.renderables.size).toBe(0);
  renderer.config.layers = { [instanceId]: layer };
  extension.startFrame(18n, "world", "world");
  await extension.settleVideoDecodes();
  expect(extension.renderables.has(instanceId)).toBe(true);
  extension.dispose();
  modelCache.dispose();
});

it("loads only the declared selected visual, commits it atomically and restores the current absolute pose on re-entry", async () => {
  const manifestUri = "package://test_description/modeling/visual_variants.json";
  const xml = (mesh: string) =>
    `<robot name="test"><xgc2_visual manifest="${manifestUri}"/><link name="base_link"><visual><geometry><mesh filename="${mesh}.dae"/></geometry></visual></link></robot>`;
  const proxy = deferred<ReturnType<typeof asset>>();
  const manifest = {
    release_visual: "release",
    variants: {
      release: { urdf: "urdf/release.urdf" },
      detail: { urdf: "urdf/detail.urdf" },
      proxy: { urdf: "urdf/proxy.urdf" },
    },
    viewer_lod: {
      reference: "detail",
      metric: "sampled_surface_m",
      errors: { detail: 0, release: 0.1, proxy: 0.2 },
      link_roles: {},
    },
  };
  mockParse.mockImplementation(() => {
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    return { scene };
  });
  const owned = new Map<string, ReturnType<typeof asset> | Promise<ReturnType<typeof asset>>>([
    [manifestUri, asset(JSON.stringify(manifest), "application/json")],
    ["package://test_description/urdf/release.urdf", asset(xml("release"), "application/xml")],
    ["package://test_description/urdf/proxy.urdf", proxy.promise],
  ]);
  const { extension, renderer, modelCache } = setup(
    Promise.resolve(asset(xml("release"), "application/xml")),
    "model",
    owned,
  );
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.updateMatrixWorld();
  Object.assign(renderer, {
    interfaceMode: "3d",
    cameraHandler: { getActiveCamera: () => camera },
    gl: { getDrawingBufferSize: (target: THREE.Vector2) => target.set(100, 100) },
  });
  await extension.settleVideoDecodes();
  const owner = extension.renderables.get("model")!;
  const original = [...owner.userData.renderables.values()][0]!;
  expect(owner.visualLod?.current).toBe("release");
  renderer.transformTree.addTransform(
    "base_link",
    "world",
    0n,
    new Transform([0, 0, -100], [0, 0, 0, 1]),
  );
  extension.startFrame(0n, "world", "world");
  expect(owner.visualLod?.requested).toBe("proxy");
  expect([...owner.userData.renderables.values()][0]).toBe(original);
  expect(original.children).toHaveLength(1);
  expect(renderer.fetchAsset.mock.calls.some(([url]) => String(url).endsWith("detail.urdf"))).toBe(
    false,
  );
  proxy.resolve(asset(xml("proxy"), "application/xml"));
  await extension.settleVideoDecodes();
  const replacement = [...owner.userData.renderables.values()][0]!;
  expect(owner.visualLod?.current).toBe("proxy");
  expect(replacement).not.toBe(original);
  expect(original.children).toHaveLength(0);
  renderer.transformTree.addTransform(
    "base_link",
    "world",
    10n,
    new Transform([2, 0, -100], [0, 0, 0, 1]),
  );
  extension.startFrame(10n, "world", "world");
  expect(replacement.position.x).toBeCloseTo(2);
  renderer.transformTree.addTransform(
    "base_link",
    "world",
    20n,
    new Transform([10000, 0, -100], [0, 0, 0, 1]),
  );
  extension.startFrame(20n, "world", "world");
  expect(owner.visible).toBe(false);
  expect(replacement.matrixAutoUpdate).toBe(false);
  renderer.transformTree.addTransform(
    "base_link",
    "world",
    21n,
    new Transform([3, 0, -100], [0, 0, 0, 1]),
  );
  extension.startFrame(21n, "world", "world");
  expect(owner.visible).toBe(true);
  expect(replacement.matrixAutoUpdate).toBe(true);
  expect(replacement.position.x).toBeCloseTo(3);
  extension.dispose();
  modelCache.dispose();
});

it("keeps committed settings and LOD with old geometry while a requested scale fails", async () => {
  const uri = "package://test_description/modeling/visual_variants.json";
  const text = `<robot name="test"><xgc2_visual manifest="${uri}"/><link name="base_link"><visual><geometry><mesh filename="wheel.dae"/></geometry></visual></link></robot>`;
  const manifest = {
    release_visual: "release",
    variants: { release: { urdf: "urdf/release.urdf" }, detail: { urdf: "urdf/detail.urdf" } },
    viewer_lod: {
      reference: "detail",
      metric: "sampled_surface_m",
      errors: { detail: 0 },
      link_roles: {},
    },
  };
  const assets = new Map<string, ReturnType<typeof asset> | Promise<ReturnType<typeof asset>>>([
    [uri, asset(JSON.stringify(manifest), "application/json")],
    ["package://test_description/urdf/release.urdf", asset(text, "application/xml")],
  ]);
  const { extension, renderer, modelCache } = setup(
    Promise.resolve(asset(text, "application/xml")),
    "model",
    assets,
  );
  await extension.settleVideoDecodes();
  const owner = extension.renderables.get("model")!;
  const complete = owner.userData;
  const lod = owner.visualLod;
  const child = [...complete.renderables.values()][0]!;
  const pending = deferred<ReturnType<typeof asset>>();
  assets.set(uri, pending.promise);
  renderer.config.layers.model = { ...renderer.config.layers.model, scale: 2 };
  const node = extension
    .settingsNodes()
    .find((entry) => entry.path[0] === "layers" && entry.path[1] === "model")!;
  node.node.handler!({
    action: "update",
    payload: { path: ["layers", "model", "scale"], input: "number", value: 2 },
  } as never);
  expect(owner.userData).toBe(complete);
  expect(owner.userData.settings).toMatchObject({ scale: 1 });
  expect(owner.visualLod).toBe(lod);
  expect([...owner.userData.renderables.values()][0]).toBe(child);
  pending.resolve(asset("{}", "application/json"));
  await extension.settleVideoDecodes();
  expect(owner.userData).toBe(complete);
  expect(owner.visualLod).toBe(lod);
  expect(renderer.settings.errors.add).toHaveBeenCalledWith(
    ["layers", "model"],
    "ParseUrdf",
    expect.stringContaining("Invalid visual_variants manifest"),
  );
  const errors = jest.mocked(console.error).mock.calls;
  expect(
    errors.every((args) => args.map(String).join(" ").includes("Invalid visual_variants manifest")),
  ).toBe(true);
  jest.mocked(console.error).mockClear();
  extension.dispose();
  modelCache.dispose();
});

it("maintains missing child TF offscreen and does not cull legal live offsets outside XML origins", async () => {
  const text =
    '<robot name="test"><link name="root"/><link name="tip"><visual><geometry><mesh filename="wheel.dae"/></geometry></visual></link><joint name="joint" type="fixed"><parent link="root"/><child link="tip"/><origin xyz="0 0 0" rpy="0 0 0"/></joint></robot>';
  const { extension, renderer, modelCache } = setup(
    Promise.resolve(asset(text, "application/xml")),
  );
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.updateMatrixWorld();
  Object.assign(renderer, {
    interfaceMode: "3d",
    cameraHandler: { getActiveCamera: () => camera },
    gl: { getDrawingBufferSize: (target: THREE.Vector2) => target.set(100, 100) },
  });
  await extension.settleVideoDecodes();
  const owner = extension.renderables.get("model")!;
  renderer.transformTree.addTransform(
    "root",
    "world",
    0n,
    new Transform([100, 0, -10], [0, 0, 0, 1]),
  );
  extension.startFrame(0n, "world", "world");
  expect(renderer.settings.errors.add).toHaveBeenCalledWith(
    ["layers", "model"],
    MISSING_TRANSFORM,
    expect.any(String),
  );
  renderer.transformTree.addTransform("tip", "root", 1n, new Transform([-100, 0, 0], [0, 0, 0, 1]));
  extension.startFrame(1n, "world", "world");
  const child = [...owner.userData.renderables.values()][0]!;
  expect(child.position.x).toBeCloseTo(0);
  expect(owner.visible).toBe(true);
  expect(child.visible).toBe(true);
  expect(renderer.settings.errors.remove).toHaveBeenCalledWith(
    ["layers", "model"],
    MISSING_TRANSFORM,
  );
  extension.dispose();
  modelCache.dispose();
});

it("does not clear a newer generation error from a completed model continuation", async () => {
  const { extension, renderer, modelCache } = setup();
  await extension.settleVideoDecodes();
  const owner = extension.renderables.get("model")!;
  const next = deferred<void>();
  let retiredAtCommit = false;
  renderer.settings.setNodesForKey.mockImplementation(() => {
    // saveSetting emits first while the old scale is still committed. Retire only the actual
    // complete-model commit, after its userData changed to the requested scale.
    if (
      retiredAtCommit ||
      !("scale" in owner.userData.settings) ||
      owner.userData.settings.scale !== 2
    )
      return;
    retiredAtCommit = true;
    ++owner.loadGeneration; // The same synchronous source-retirement fence used by the owner.
    renderer.settings.errors.add(["layers", "model"], "ParseUrdf", "New generation error");
    renderer.settings.errors.remove.mockClear();
    next.resolve();
  });
  renderer.config.layers.model = { ...renderer.config.layers.model, scale: 2 };
  const node = extension
    .settingsNodes()
    .find((entry) => entry.path[0] === "layers" && entry.path[1] === "model")!;
  node.node.handler!({
    action: "update",
    payload: { path: ["layers", "model", "scale"], input: "number", value: 2 },
  } as never);
  await next.promise;
  await extension.settleVideoDecodes();
  expect(renderer.settings.errors.remove).not.toHaveBeenCalledWith(
    ["layers", "model"],
    "ParseUrdf",
  );
  extension.dispose();
  modelCache.dispose();
});

it("submits compatible loaded URDF meshes as one owned batch while retiring only eligible clones", async () => {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ color: 0x6699aa });
  const texture = new THREE.Texture();
  material.map = texture;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(1, 2, 3);
  mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  mesh.scale.set(2, 3, 4);
  const cached = new THREE.Group();
  cached.add(mesh);
  mockParse.mockReturnValueOnce({ scene: cached });
  const { extension, renderer, modelCache } = setup();
  await extension.settleVideoDecodes();
  renderer.config.layers.other = { ...renderer.config.layers.model! };
  extension.startFrame(0n, "world", "world");
  await extension.settleVideoDecodes();
  const owners = [...extension.renderables.values()];
  for (const owner of owners) owner.visible = true;
  const children = owners.map(
    (owner) => [...owner.userData.renderables.values()][0] as RenderableMeshResource,
  );
  for (const child of children) {
    child.visible = true;
    expect(child.children).toHaveLength(0);
    expect(child.getVisualInstanceParts()).toHaveLength(1);
  }
  const sharedGeometry = children[0]!.getVisualInstanceParts()[0]!.geometry;
  const sharedMaterial = children[0]!.getVisualInstanceParts()[0]!.material;
  expect(children[1]!.getVisualInstanceParts()[0]!.geometry).toBe(sharedGeometry);
  expect(children[1]!.getVisualInstanceParts()[0]!.material).toBe(sharedMaterial);
  const releasedGeometry = jest.spyOn(sharedGeometry, "dispose"),
    releasedTexture = jest.spyOn(texture, "dispose");
  expect(extension.prepareVisualDraw()).toBe(true);
  const batch = extension.children.find((child) =>
    child.children.some((item) => item instanceof THREE.InstancedMesh),
  )!;
  const draws = batch.children.filter(
    (child) => child instanceof THREE.InstancedMesh,
  ) as THREE.InstancedMesh[];
  expect(draws).toHaveLength(1);
  expect(draws[0]!.count).toBe(2);
  const fence = (
    draws[0]!.userData.logicalPickFence as () => import("./urdfVisualInstances").LogicalPickFence
  )();
  ++owners[0]!.loadGeneration;
  expect(fence.isCurrent(owners[0]!.id)).toBe(true); // New pending load does not retire last complete visuals.
  owners[0]!.removeChildren();
  expect(fence.isCurrent(owners[0]!.id)).toBe(false);
  extension.prepareVisualDraw();
  extension.dispose();
  expect(releasedGeometry).not.toHaveBeenCalled();
  expect(releasedTexture).not.toHaveBeenCalled();
  modelCache.dispose();
  expect(releasedGeometry).toHaveBeenCalledTimes(1);
  expect(releasedTexture).toHaveBeenCalledTimes(1);
  releasedGeometry.mockRestore();
  releasedTexture.mockRestore();
});
