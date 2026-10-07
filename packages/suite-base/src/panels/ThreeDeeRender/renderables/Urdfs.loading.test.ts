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

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "draco.wasm");
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "");
jest.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/STLLoader.js", () => ({}));
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
  follow: {
    followTf?: string;
    followMode?: "follow-position" | "follow-pose";
    framePrefix?: string;
  } = {},
) {
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
    fixedFrameId: "current-world",
    fetchAsset,
    modelCache,
    on: jest.fn(),
    addCustomLayerAction: jest.fn(),
    config: {
      followTf: follow.followTf,
      followMode: follow.followMode,
      layers: {
        model: {
          layerId: "foxglove.Urdf",
          sourceType: "url",
          url: "https://models.invalid/robot.urdf",
          label: "Robot",
          framePrefix: follow.framePrefix ?? "",
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
        hasError: jest.fn(() => false),
      },
    },
    updateConfig: jest.fn(),
    addCoordinateFrame: jest.fn(),
    addTransform: jest.fn(),
    removeTransform: jest.fn(),
    normalizeFrameId: (frame: string) => frame,
    queueAnimationFrame: jest.fn(),
  };
  const extension = new Urdfs(renderer as unknown as IRenderer);
  return { extension, renderer, modelCache };
}

it.each([
  "xgc/robots/uav1/base_link",
  "xgc/robots/uav1/removed_root",
])("validates restored %s only after the current native URDF resolves its real root", async (followTf) => {
  const originalUrl = window.location.href;
  window.history.replaceState(
    {},
    "",
    `/?xgc2Embed=1&xgc2LayoutScope=${encodeURIComponent(JSON.stringify(["experiment-a", "viewer"]))}`,
  );
  const pending = deferred<ReturnType<typeof asset>>();
  const { extension, renderer, modelCache } = setup(pending.promise, {
    followMode: "follow-position",
    followTf,
    framePrefix: "xgc/robots/uav1/",
  });
  try {
    expect(extension.robotFollowFrames()).toEqual([]);
    expect(renderer.settings.handleAction).not.toHaveBeenCalled();
    pending.resolve(asset(urdf, "application/xml"));
    await extension.settleVideoDecodes();
    expect(extension.robotFollowFrames()).toEqual([
      { label: "Robot", value: "xgc/robots/uav1/base_link" },
    ]);
    const expected =
      followTf === "xgc/robots/uav1/base_link"
        ? []
        : [
            [
              {
                action: "update",
                payload: { input: "select", path: ["general", "followMode"], value: "follow-none" },
              },
            ],
            [
              {
                action: "update",
                payload: { input: "select", path: ["general", "followTf"], value: "current-world" },
              },
            ],
          ];
    expect(renderer.settings.handleAction.mock.calls).toEqual(expected);
  } finally {
    extension.dispose();
    modelCache.dispose();
    window.history.replaceState({}, "", originalUrl);
  }
});
it("drains the real model and texture promise before an offline frame can settle", async () => {
  const decoding = deferred<THREE.LoadingManager>();
  mockParse.mockImplementationOnce((manager) => {
    manager.itemStart("texture");
    decoding.resolve(manager);
    return { scene: colladaScene() };
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
  // The static link's mesh visual draws from the shared instance pool; its
  // per-link renderable list stays empty and nothing is instanced until the
  // real texture promise resolves.
  expect(extension.renderables.get("model")!.userData.renderables.size).toBe(0);
  expect(extension.robotFollowFrames()).toEqual([{ label: "Robot", value: "base_link" }]);
  expect(settled).toBe(false);
  expect(extension.instancePool.batches()).toHaveLength(0);
  manager.itemEnd("texture");
  await ready;
  const batches = extension.instancePool.batches();
  expect(batches).toHaveLength(1);
  expect(batches[0]!.instancedMesh().count).toBe(1);
  extension.dispose();
  modelCache.dispose();
});

it("settles a failed texture with an authoritative error, never a mesh", async () => {
  const decoding = deferred<THREE.LoadingManager>();
  mockParse.mockImplementationOnce((manager) => {
    manager.itemStart("texture");
    decoding.resolve(manager);
    return { scene: colladaScene() };
  });
  const { extension, renderer, modelCache } = setup();
  const ready = extension.settleVideoDecodes();
  const manager = await decoding.promise;
  manager.itemError("texture");
  manager.itemEnd("texture");
  await ready;
  expect(extension.renderables.get("model")!.userData.renderables.size).toBe(0);
  expect(extension.instancePool.batches()).toHaveLength(0);
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
    return { scene: colladaScene() };
  });
  const { extension, renderer, modelCache } = setup();
  const manager = await decoding.promise;
  extension.removeAllRenderables();
  expect(extension.renderables.size).toBe(1);
  extension.dispose();
  expect(extension.instancePool.batches()).toHaveLength(0);
  const reloaded = new Urdfs(renderer as unknown as IRenderer);
  manager.itemEnd("texture");
  await Promise.all([extension.settleVideoDecodes(), reloaded.settleVideoDecodes()]);
  expect(extension.instancePool.batches()).toHaveLength(0);
  const batches = reloaded.instancePool.batches();
  expect(batches).toHaveLength(1);
  expect(batches[0]!.instancedMesh().count).toBe(1);
  expect(
    renderer.fetchAsset.mock.calls.filter(([url]) => (url as string).endsWith(".dae")),
  ).toHaveLength(1);
  extension.dispose();
  reloaded.dispose();
  modelCache.dispose();
});

// One-leaf Collada stand-in so the pooled static mesh visual gets a slot.
function colladaScene(): THREE.Group {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
  return scene;
}
