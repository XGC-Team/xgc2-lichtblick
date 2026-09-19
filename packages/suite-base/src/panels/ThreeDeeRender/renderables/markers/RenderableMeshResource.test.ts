/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { setImmediate as nextTurn } from "timers";

import { RenderableMeshResource } from "./RenderableMeshResource";
import type { IRenderer } from "../../IRenderer";
import { Marker, MarkerAction, MarkerType } from "../../ros";

jest.mock("../../ModelCache", () => ({ EDGE_LINE_SEGMENTS_NAME: "edges" }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function marker(url = "https://models.invalid/wheel.dae"): Marker {
  return {
    header: { frame_id: "base_link", stamp: { sec: 0, nsec: 0 } },
    ns: "",
    id: 0,
    type: MarkerType.MESH_RESOURCE,
    action: MarkerAction.ADD,
    pose: {
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    scale: { x: 1, y: 1, z: 1 },
    color: { r: 1, g: 1, b: 1, a: 1 },
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    points: [],
    colors: [],
    text: "",
    mesh_resource: url,
    mesh_use_embedded_materials: true,
  };
}
function setup(load: jest.Mock) {
  const renderer = {
    modelCache: { load },
    normalizeFrameId: (frame: string) => frame,
    config: { topics: {}, layers: {} },
    settings: {
      errors: {
        add: jest.fn(),
        remove: jest.fn(),
        hasError: jest.fn(() => false),
      },
    },
    queueAnimationFrame: jest.fn(),
  };
  const renderable = new RenderableMeshResource(
    "mesh",
    marker(),
    undefined,
    renderer as unknown as IRenderer,
  );
  return { renderer, renderable };
}

it("settles only after the current mesh attaches", async () => {
  const model = deferred<THREE.Group>();
  const { renderable, renderer } = setup(jest.fn(async () => await model.promise));
  let settled = false;
  const loading = renderable.settleLoading().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => {
    nextTurn(resolve);
  });
  expect(settled).toBe(false);
  expect(renderable.children).toHaveLength(0);
  model.resolve(new THREE.Group());
  await loading;
  expect(renderable.children).toHaveLength(1);
  expect(renderer.queueAnimationFrame).toHaveBeenCalledTimes(1);
  renderable.dispose();
});

it("never attaches or reports an error for a disposed pending mesh", async () => {
  const model = deferred<THREE.Group>();
  const load = jest.fn(async () => await model.promise);
  const { renderable, renderer } = setup(load);
  renderable.dispose();
  const cached = new THREE.Group();
  const clone = jest.spyOn(cached, "clone");
  model.resolve(cached);
  await renderable.settleLoading();
  expect(clone).not.toHaveBeenCalled();
  expect(renderable.children).toHaveLength(0);
  expect(renderer.queueAnimationFrame).not.toHaveBeenCalled();
  expect(renderer.settings.errors.add).not.toHaveBeenCalled();
  renderable.dispose();
});

it("follows replacement loads and ignores stale errors", async () => {
  const first = deferred<THREE.Group | undefined>(),
    second = deferred<THREE.Group>();
  const load = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { renderable, renderer } = setup(load);
  const settled = renderable.settleLoading();
  renderable.update(marker("https://models.invalid/body.dae"), undefined);
  const report = load.mock.calls[0]![2] as (error: Error) => void;
  report(new Error("stale texture failure"));
  first.resolve(undefined);
  const fresh = new THREE.Group();
  fresh.name = "body";
  second.resolve(fresh);
  await settled;
  expect(renderable.children.map((child) => child.name)).toEqual(["body"]);
  expect(renderer.settings.errors.add).not.toHaveBeenCalled();
  renderable.dispose();
});

it("keeps a texture failure in settings after the load settles", async () => {
  const load = jest
    .fn()
    .mockImplementation(async (_url: string, _opts: unknown, report: (error: Error) => void) => {
      report(new Error("Texture decode failed"));
      return undefined;
    });
  const { renderable, renderer } = setup(load);
  await renderable.settleLoading();
  expect(renderable.children).toHaveLength(0);
  expect(renderer.settings.errors.add).toHaveBeenCalledWith(
    ["topics", "mesh"],
    "MESH_FETCH_FAILED",
    expect.stringContaining("Texture decode failed"),
  );
  expect(renderer.settings.errors.remove).not.toHaveBeenCalled();
  renderable.dispose();
});

it("isolates instance materials while the cache keeps shared geometry and textures", async () => {
  const geometry = new THREE.BoxGeometry();
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture, color: 0xffffff });
  const cached = new THREE.Group();
  cached.add(new THREE.Mesh(geometry, material));
  const load = jest.fn().mockResolvedValue(cached);
  const a = setup(load).renderable,
    b = setup(load).renderable;
  await Promise.all([a.settleLoading(), b.settleLoading()]);
  const meshA = a.children[0]!.children[0] as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  >;
  const meshB = b.children[0]!.children[0] as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  >;
  expect(meshA.geometry).toBe(geometry);
  expect(meshB.geometry).toBe(geometry);
  expect(meshA.material).not.toBe(meshB.material);
  expect(meshA.material).not.toBe(material);
  expect(meshA.material.map).toBe(texture);
  expect(meshB.material.map).toBe(texture);
  meshA.material.color.set("red");
  expect(meshB.material.color.getHex()).toBe(0xffffff);
  expect(material.color.getHex()).toBe(0xffffff);
  const geometryDisposed = jest.spyOn(geometry, "dispose"),
    textureDisposed = jest.spyOn(texture, "dispose");
  const cachedDisposed = jest.spyOn(material, "dispose"),
    aDisposed = jest.spyOn(meshA.material, "dispose"),
    bDisposed = jest.spyOn(meshB.material, "dispose");
  a.dispose();
  a.dispose();
  expect(aDisposed).toHaveBeenCalledTimes(1);
  expect(bDisposed).not.toHaveBeenCalled();
  expect(geometryDisposed).not.toHaveBeenCalled();
  expect(textureDisposed).not.toHaveBeenCalled();
  expect(cachedDisposed).not.toHaveBeenCalled();
  expect(b.children).toHaveLength(1);
  b.dispose();
  expect(bDisposed).toHaveBeenCalledTimes(1);
  expect(textureDisposed).not.toHaveBeenCalled();
  geometry.dispose();
  material.dispose();
  texture.dispose();
});

it("overrides embedded materials without disposing the cache's resources", async () => {
  const geometry = new THREE.BoxGeometry(),
    texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const cached = new THREE.Group();
  cached.add(new THREE.Mesh(geometry, material));
  const { renderable } = setup(jest.fn().mockResolvedValue(cached));
  await renderable.settleLoading();
  const disposedMaterial = jest.spyOn(material, "dispose"),
    disposedTexture = jest.spyOn(texture, "dispose");
  renderable.update({ ...marker(), mesh_use_embedded_materials: false }, undefined, true);
  await renderable.settleLoading();
  const mesh = renderable.children[0]!.children[0] as THREE.Mesh;
  expect(mesh.material).not.toBe(material);
  expect(disposedMaterial).not.toHaveBeenCalled();
  expect(disposedTexture).not.toHaveBeenCalled();
  renderable.dispose();
  expect(disposedMaterial).not.toHaveBeenCalled();
  expect(disposedTexture).not.toHaveBeenCalled();
  geometry.dispose();
  material.dispose();
  texture.dispose();
});
