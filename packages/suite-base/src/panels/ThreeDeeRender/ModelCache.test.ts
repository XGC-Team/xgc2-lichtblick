/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { ModelCache } from "./ModelCache";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "draco.wasm");
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "");
jest.mock("three/examples/jsm/loaders/DRACOLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({}));
jest.mock("three/examples/jsm/loaders/STLLoader.js", () => ({}));

jest.mock("three/examples/jsm/loaders/ColladaLoader.js", () => {
  const { Group } = jest.requireActual<typeof import("three")>("three");
  return {
    ColladaLoader: class {
      public parse() {
        return { scene: new Group() };
      }
    },
  };
});

it("fetches a COLLADA image once without fetching its internal surface reference", async () => {
  const xml = `<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema">
    <library_images><image id="wheel_image"><init_from>wheel.png</init_from></image></library_images>
    <library_effects><effect id="rubber"><profile_COMMON>
      <newparam sid="surface"><surface type="2D"><init_from>wheel_image</init_from></surface></newparam>
    </profile_COMMON></effect></library_effects>
  </COLLADA>`;
  const fetchAsset = jest.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("wheel.dae")) {
      return { data: new TextEncoder().encode(xml), mediaType: "model/vnd.collada+xml" };
    }
    if (url.endsWith("wheel.png")) {
      return { data: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" };
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
