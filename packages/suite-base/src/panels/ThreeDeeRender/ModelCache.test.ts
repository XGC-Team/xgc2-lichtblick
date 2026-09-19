/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { setImmediate as nextTurn } from "timers";

import { ModelCache } from "./ModelCache";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "draco.wasm");
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "");
jest.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/STLLoader.js", () => ({}));

const mockColladaParse = jest.fn((_manager: THREE.LoadingManager) => ({
  scene: new THREE.Group(),
}));
jest.mock("three/examples/jsm/loaders/ColladaLoader.js", () => ({
  ColladaLoader: class {
    public constructor(private mockManager: THREE.LoadingManager) {}
    public parse() {
      return mockColladaParse(this.mockManager);
    }
  },
}));

const originalURL = globalThis.URL;
const createObjectURL = jest.fn(() => "blob:owned-texture");
const revokeObjectURL = jest.fn();
beforeAll(() => {
  globalThis.URL = class extends originalURL {
    public static override createObjectURL = createObjectURL;
    public static override revokeObjectURL = revokeObjectURL;
  };
});
afterAll(() => {
  globalThis.URL = originalURL;
});
beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});
function consumeExpectedErrors() {
  const calls = (console.error as jest.Mock).mock.calls;
  for (const [error] of calls) {
    expect(String(error)).toMatch(/COLLADA|outside snapshot/);
  }
  (console.error as jest.Mock).mockClear();
}

it("fetches a COLLADA image once without fetching its internal surface reference", async () => {
  const xml = `<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema">
    <library_images><image id="wheel_image"><init_from>wheel.png</init_from></image></library_images>
    <library_effects><effect id="rubber"><profile_COMMON>
      <newparam sid="surface"><surface type="2D"><init_from>wheel_image</init_from></surface></newparam>
    </profile_COMMON></effect></library_effects>
  </COLLADA>`;
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("wheel.dae")) {
      return {
        data: new TextEncoder().encode(xml),
        mediaType: "model/vnd.collada+xml",
      };
    }
    if (url.endsWith("wheel.png")) {
      return {
        data: new Uint8Array([137, 80, 78, 71]),
        mediaType: "image/png",
      };
    }
    throw new Error(`Unexpected asset: ${url}`);
  });
  const cache = new ModelCache({
    fetchAsset,
    edgeMaterial: new THREE.MeshBasicMaterial(),
    ignoreColladaUpAxis: false,
    meshUpAxis: "z_up",
  });
  const onError = jest.fn();
  const model = await cache.load("package://scout_description/meshes/wheel.dae", {}, onError);
  expect(onError).not.toHaveBeenCalled();
  expect(model).toBeDefined();
  expect(fetchAsset.mock.calls.map(([url]) => url)).toEqual([
    "package://scout_description/meshes/wheel.dae",
    "package://scout_description/meshes/wheel.png",
  ]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function textureCache(fetchTexture?: () => Promise<{ data: Uint8Array; mediaType: string }>) {
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith(".dae")) {
      return {
        data: new TextEncoder().encode(
          "<COLLADA><library_images><image><init_from>wheel.png</init_from></image></library_images></COLLADA>",
        ),
        mediaType: "model/vnd.collada+xml",
      };
    }
    return fetchTexture
      ? await fetchTexture()
      : { data: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" };
  });
  return new ModelCache({
    fetchAsset,
    edgeMaterial: new THREE.MeshBasicMaterial(),
    ignoreColladaUpAxis: false,
    meshUpAxis: "z_up",
  });
}

it("waits for the COLLADA LoadingManager to finish texture decoding", async () => {
  const parsed = deferred<THREE.LoadingManager>();
  mockColladaParse.mockImplementationOnce((manager: THREE.LoadingManager) => {
    manager.itemStart("delayed-texture");
    parsed.resolve(manager);
    return { scene: new THREE.Group() };
  });
  const cache = textureCache();
  const onError = jest.fn();
  let settled = false;
  const loading = cache.load("https://models.invalid/wheel.dae", {}, onError).then((value) => {
    settled = true;
    return value;
  });
  const manager = await parsed.promise;
  await new Promise<void>((resolve) => {
    nextTurn(resolve);
  });
  expect(settled).toBe(false);
  manager.itemEnd("delayed-texture");
  expect(await loading).toBeDefined();
  expect(onError).not.toHaveBeenCalled();
  cache.dispose();
});

it("does not return a model whose texture failed to decode", async () => {
  const parsed = deferred<THREE.LoadingManager>();
  mockColladaParse.mockImplementationOnce((manager: THREE.LoadingManager) => {
    manager.itemStart("broken-texture");
    parsed.resolve(manager);
    return { scene: new THREE.Group() };
  });
  const cache = textureCache();
  const onError = jest.fn();
  const loading = cache.load("https://models.invalid/wheel.dae", {}, onError);
  const manager = await parsed.promise;
  manager.itemError("broken-texture");
  manager.itemEnd("broken-texture");
  const result = await loading;
  consumeExpectedErrors();
  expect(result).toBeUndefined();
  expect(onError).toHaveBeenCalled();
  cache.dispose();
});

it("does not fall back to a network texture when the asset owner rejects it", async () => {
  const cache = textureCache(async () => {
    throw new Error("texture is outside snapshot");
  });
  const onError = jest.fn();
  const calls = mockColladaParse.mock.calls.length;
  const result = await cache.load("https://models.invalid/wheel.dae", {}, onError);
  consumeExpectedErrors();
  expect(result).toBeUndefined();
  expect(mockColladaParse.mock.calls.length).toBe(calls);
  expect(onError).toHaveBeenCalled();
  cache.dispose();
});

it("revokes the actual texture blob URL exactly once on disposal", async () => {
  const cache = textureCache();
  await cache.load("https://models.invalid/wheel.dae", {}, jest.fn());
  cache.dispose();
  cache.dispose();
  expect(revokeObjectURL.mock.calls).toEqual([["blob:owned-texture"]]);
});

it("does not create a texture URL or attach a model after disposal during fetch", async () => {
  const texture = deferred<{ data: Uint8Array; mediaType: string }>();
  const requested = deferred<void>();
  const cache = textureCache(async () => {
    requested.resolve();
    return await texture.promise;
  });
  const loading = cache.load("https://models.invalid/wheel.dae", {}, jest.fn());
  await requested.promise;
  cache.dispose();
  texture.resolve({
    data: new Uint8Array([137, 80, 78, 71]),
    mediaType: "image/png",
  });
  expect(await loading).toBeUndefined();
  expect(createObjectURL).not.toHaveBeenCalled();
});

it("owns cached geometry, material and textures through final disposal", async () => {
  const geometry = new THREE.BoxGeometry(),
    texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  mockColladaParse.mockReturnValueOnce({ scene });
  const cache = textureCache();
  await cache.load("https://models.invalid/wheel.dae", {}, jest.fn());
  const disposedGeometry = jest.spyOn(geometry, "dispose"),
    disposedMaterial = jest.spyOn(material, "dispose"),
    disposedTexture = jest.spyOn(texture, "dispose");
  cache.dispose();
  cache.dispose();
  expect(disposedGeometry).toHaveBeenCalledTimes(1);
  expect(disposedMaterial).toHaveBeenCalledTimes(1);
  expect(disposedTexture).toHaveBeenCalledTimes(1);
});

it("disposes resources from a decode completing after cache shutdown", async () => {
  const geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshStandardMaterial();
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material));
  const parsed = deferred<THREE.LoadingManager>();
  mockColladaParse.mockImplementationOnce((manager) => {
    manager.itemStart("late-texture");
    parsed.resolve(manager);
    return { scene };
  });
  const cache = textureCache();
  const onError = jest.fn();
  const loading = cache.load("https://models.invalid/wheel.dae", {}, onError);
  const manager = await parsed.promise;
  const disposedGeometry = jest.spyOn(geometry, "dispose"),
    disposedMaterial = jest.spyOn(material, "dispose");
  cache.dispose();
  manager.itemEnd("late-texture");
  expect(await loading).toBeUndefined();
  expect(onError).not.toHaveBeenCalled();
  expect(disposedGeometry).toHaveBeenCalledTimes(1);
  expect(disposedMaterial).toHaveBeenCalledTimes(1);
});
