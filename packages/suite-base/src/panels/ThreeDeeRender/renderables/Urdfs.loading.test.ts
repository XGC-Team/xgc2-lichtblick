/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { setImmediate as nextTurn } from "timers";

import { Urdfs } from "./Urdfs";
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
function setup(urdfAsset = Promise.resolve(asset(urdf, "application/xml")), instanceId = "model") {
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
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
  const child = [...extension.renderables.get("model")!.userData.renderables.values()][0]!;
  expect(extension.robotFollowFrames()).toEqual([{ label: "Robot", value: "base_link" }]);
  expect(settled).toBe(false);
  expect(child.children).toHaveLength(0);
  manager.itemEnd("texture");
  await ready;
  expect(child.children).toHaveLength(1);
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
  const child = [...extension.renderables.get("model")!.userData.renderables.values()][0]!;
  expect(child.children).toHaveLength(0);
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
  const removed = [...extension.renderables.get("model")!.userData.renderables.values()][0]!;
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
