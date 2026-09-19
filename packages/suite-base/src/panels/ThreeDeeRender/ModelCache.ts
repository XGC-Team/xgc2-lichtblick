// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { MeshoptDecoder } from "meshoptimizer";
import * as THREE from "three";
import dracoDecoderWasmUrl from "three/examples/jsm/libs/draco/draco_decoder.wasm";
import dracoWasmWrapperJs from "three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import Logger from "@lichtblick/log";
import { BuiltinPanelExtensionContext } from "@lichtblick/suite-base/components/PanelExtensionAdapter";

const log = Logger.getLogger(__filename);

export type MeshUpAxis = "y_up" | "z_up";
export const DEFAULT_MESH_UP_AXIS: MeshUpAxis = "y_up";

export type ModelCacheOptions = {
  edgeMaterial: THREE.Material;
  ignoreColladaUpAxis: boolean;
  meshUpAxis: MeshUpAxis;
  fetchAsset: BuiltinPanelExtensionContext["unstable_fetchAsset"];
};

type LoadModelOptions = {
  overrideMediaType?: string;
  /** A URL to e.g. a URDf which may be used to resolve mesh package:// URLs */
  referenceUrl?: string;
};

export type LoadedModel = THREE.Group | THREE.Scene;

type ErrorCallback = (err: Error) => void;

const DEFAULT_COLOR = new THREE.Color(0x248eff);

const GLTF_MIME_TYPES = ["model/gltf", "model/gltf-binary", "model/gltf+json"];
// Sourced from <https://github.com/Ultimaker/Cura/issues/4141>
const STL_MIME_TYPES = ["model/stl", "model/x.stl-ascii", "model/x.stl-binary", "application/sla"];
const DAE_MIME_TYPES = ["model/vnd.collada+xml"];
const OBJ_MIME_TYPES = ["model/obj", "text/prs.wavefront-obj"];

export class ModelCache {
  #textDecoder = new TextDecoder();
  #models = new Map<string, Promise<LoadedModel | undefined>>();
  #loadedModels = new Set<LoadedModel>();
  #fetchAsset: BuiltinPanelExtensionContext["unstable_fetchAsset"];
  #colladaTextureObjectUrls = new Map<string, string>();
  #dracoLoader?: DRACOLoader;
  #lifetime = new AbortController();

  public constructor(public readonly options: ModelCacheOptions) {
    this.#fetchAsset = options.fetchAsset;
  }

  public async load(
    url: string,
    opts: LoadModelOptions,
    reportError: ErrorCallback,
  ): Promise<LoadedModel | undefined> {
    if (this.#lifetime.signal.aborted) {
      return undefined;
    }
    let promise = this.#models.get(url);
    if (promise) {
      return await promise;
    }

    // Skip mesh edge overlays by default. Dense DAE/URDF meshes (quadruped,
    // vehicles, drones) look "ink-outlined" black with EdgesGeometry; markers
    // can still opt into outlines via showOutlines on non-mesh primitives.
    promise = this.#loadModel(url, opts, reportError)
      .then((model) => {
        if (this.#lifetime.signal.aborted) {
          disposeCachedModels([model]);
          return undefined;
        }
        this.#loadedModels.add(model);
        model.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        return model;
      })
      .catch(async (err: unknown) => {
        if (!this.#lifetime.signal.aborted) {
          reportError(err as Error);
        }
        return undefined;
      });

    this.#models.set(url, promise);
    return await promise;
  }

  async #loadModel(
    url: string,
    options: LoadModelOptions,
    reportError: ErrorCallback,
  ): Promise<LoadedModel> {
    const GLB_MAGIC = 0x676c5446; // "glTF"

    const asset = await this.#fetchAsset(url, {
      referenceUrl: options.referenceUrl,
      signal: this.#lifetime.signal,
    });
    this.#assertActive();

    const buffer = asset.data;
    if (buffer.byteLength < 4) {
      throw new Error(`${buffer.byteLength} bytes received`);
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const contentType = options.overrideMediaType ?? asset.mediaType ?? "";

    // Check if this is a glTF .glb or .gltf file
    if (
      GLB_MAGIC === view.getUint32(0, false) ||
      GLTF_MIME_TYPES.includes(contentType) ||
      /\.glb$/i.test(url) ||
      /\.gltf$/i.test(url)
    ) {
      // Create a copy of the array buffer to respect the `byteOffset` and `byteLength` value as
      // the underlying three.js STLLoader only accepts an ArrayBuffer instance.
      return await this.#loadGltf(
        url,
        (buffer.buffer as ArrayBuffer).slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ),
        reportError,
      );
    }

    // Check if this is a STL file based on content-type or file extension
    if (STL_MIME_TYPES.includes(contentType) || /\.stl$/i.test(url)) {
      // Create a copy of the array buffer to respect the `byteOffset` and `byteLength` value as
      // the underlying three.js STLLoader only accepts an ArrayBuffer instance.
      return this.#loadSTL(
        url,
        (buffer.buffer as ArrayBuffer).slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ),
        this.options.meshUpAxis,
      );
    }

    // Check if this is a COLLADA file based on content-type or file extension
    if (DAE_MIME_TYPES.includes(contentType) || /\.dae$/i.test(url)) {
      const text = this.#textDecoder.decode(buffer);
      return await this.#loadCollada(url, text, this.options.ignoreColladaUpAxis);
    }

    // Check if this is an OBJ file based on content-type or file extension
    if (OBJ_MIME_TYPES.includes(contentType) || /\.obj$/i.test(url)) {
      const text = this.#textDecoder.decode(buffer);
      return await this.#loadOBJ(url, text, this.options.meshUpAxis, reportError);
    }

    throw new Error(`Unknown ${buffer.byteLength} byte mesh (content-type: "${contentType}")`);
  }

  async #loadGltf(
    url: string,
    buffer: ArrayBuffer,
    reportError: ErrorCallback,
  ): Promise<LoadedModel> {
    const onError = (assetUrl: string) => {
      const originalUrl = unrewriteUrl(assetUrl);
      log.error(`Failed to load GLTF asset "${originalUrl}" for "${url}"`);
      reportError(new Error(`Failed to load GLTF asset "${originalUrl}"`));
    };

    const manager = new THREE.LoadingManager(undefined, undefined, onError);
    manager.setURLModifier(rewriteUrl);
    const gltfLoader = new GLTFLoader(manager);
    gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    gltfLoader.setDRACOLoader(this.#getDracoLoader(manager));

    manager.itemStart(url);
    const gltf = await gltfLoader.parseAsync(buffer, "");
    manager.itemEnd(url);

    // THREE.js uses Y-up, while Studio follows the ROS
    // [REP-0103](https://www.ros.org/reps/rep-0103.html) convention of Z-up
    gltf.scene.rotateX(Math.PI / 2);

    return gltf.scene;
  }

  #loadSTL(url: string, buffer: ArrayBuffer, meshUpAxis: MeshUpAxis): LoadedModel {
    // STL files do not reference any external assets, no LoadingManager needed
    const stlLoader = new STLLoader();
    const bufferGeometry = stlLoader.parse(buffer);
    log.debug(`Finished loading STL from ${url}`);
    const material = new THREE.MeshStandardMaterial({
      name: url.slice(-32), // truncate to 32 characters
      color: DEFAULT_COLOR,
      metalness: 0,
      roughness: 1,
      dithering: true,
    });
    const mesh = new THREE.Mesh(bufferGeometry, material);
    const group = new THREE.Group();
    group.add(mesh);

    // THREE.js uses Y-up, while Studio follows the ROS
    // [REP-0103](https://www.ros.org/reps/rep-0103.html) convention of Z-up
    if (meshUpAxis === "y_up") {
      group.rotateX(Math.PI / 2);
    }

    return group;
  }

  async #loadCollada(
    url: string,
    text: string,
    // eslint-disable-next-line @lichtblick/no-boolean-parameters
    ignoreUpAxis: boolean,
  ): Promise<LoadedModel> {
    // The three.js ColladaLoader handles <up_axis> by detecting Z_UP and simply
    // applying a scene rotation. Since Studio is already Z_UP, we do our own
    // <up_axis> handling and skip rotation entirely for the Z_UP case
    const xml = new DOMParser().parseFromString(text, "application/xml");
    const upAxis = ignoreUpAxis
      ? "Z_UP"
      : (xml.querySelector("up_axis")?.textContent ?? "Y_UP").trim().toUpperCase();
    xml.querySelectorAll("up_axis").forEach((node) => {
      node.remove();
    });
    const xmlText = xml.documentElement.outerHTML;

    // Preload textures. We do this here since we can't pass in an async function in LoadingManager.setURLModifier
    // which is supposed to be used for overriding loading behavior. See also
    // https://threejs.org/docs/index.html#api/en/loaders/managers/LoadingManager.setURLModifier
    // Surface init_from values name image IDs, not external resources.
    for (const node of xml.querySelectorAll("library_images image > init_from")) {
      if (!node.textContent) {
        continue;
      }

      const textureUrl = new URL(node.textContent, baseUrl(url)).toString();
      if (this.#colladaTextureObjectUrls.has(textureUrl)) {
        continue;
      }
      // Fetch failures are authoritative. Never let the loader retry outside
      // the asset owner (including immutable offline snapshot confinement).
      const textureAsset = await this.#fetchAsset(textureUrl, {
        signal: this.#lifetime.signal,
      });
      this.#assertActive();
      // Another model may have completed the same texture fetch meanwhile.
      if (!this.#colladaTextureObjectUrls.has(textureUrl)) {
        const objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(textureAsset.data)], {
            type: textureAsset.mediaType,
          }),
        );
        this.#colladaTextureObjectUrls.set(textureUrl, objectUrl);
      }
    }

    let textureError: Error | undefined;
    let loaded!: () => void;
    const texturesReady = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const manager = new THREE.LoadingManager(loaded, undefined, (assetUrl) => {
      textureError ??= new Error(`Failed to load COLLADA asset "${assetUrl}" for "${url}"`);
    });
    manager.setURLModifier((u) => {
      const textureUrl = new URL(u, baseUrl(url)).toString();
      const objectUrl = this.#colladaTextureObjectUrls.get(textureUrl);
      if (!objectUrl) {
        throw new Error(`COLLADA asset was not fetched by its owner: "${textureUrl}"`);
      }
      return objectUrl;
    });
    const daeLoader = new ColladaLoader(manager);

    manager.itemStart(url);
    const dae = daeLoader.parse(xmlText, baseUrl(url));
    manager.itemEnd(url);
    try {
      await texturesReady;
      this.#assertActive();
      if (textureError) {
        throw textureError;
      }
    } catch (error) {
      disposeCachedModels([dae.scene]);
      throw error;
    }

    // If the <up_axis> is Y_UP, rotate to the Studio convention of Z-up following
    // ROS [REP-0103](https://www.ros.org/reps/rep-0103.html)
    if (upAxis === "Y_UP") {
      dae.scene.rotateX(Math.PI / 2);
    }

    return fixDaeMaterials(dae.scene);
  }

  async #loadOBJ(
    url: string,
    text: string,
    meshUpAxis: MeshUpAxis,
    reportError: ErrorCallback,
  ): Promise<LoadedModel> {
    const onError = (assetUrl: string) => {
      const originalUrl = unrewriteUrl(assetUrl);
      log.error(`Failed to load OBJ asset "${originalUrl}" for "${url}"`);
      reportError(new Error(`Failed to load OBJ asset "${originalUrl}"`));
    };

    const manager = new THREE.LoadingManager(undefined, undefined, onError);
    manager.setURLModifier(rewriteUrl);
    const objLoader = new OBJLoader(manager);

    manager.itemStart(url);
    const group = objLoader.parse(text);
    manager.itemEnd(url);

    // THREE.js uses Y-up, while Studio follows the ROS
    // [REP-0103](https://www.ros.org/reps/rep-0103.html) convention of Z-up
    if (meshUpAxis === "y_up") {
      group.rotateX(Math.PI / 2);
    }

    return fixObjMaterials(group);
  }

  // singleton dracoloader
  #getDracoLoader(manager: THREE.LoadingManager): DRACOLoader {
    let dracoLoader = this.#dracoLoader;
    if (!dracoLoader) {
      dracoLoader = new DRACOLoader(manager);
      // Hack in a replacement function to load assets from the webpack bundle
      (
        dracoLoader as {
          _loadLibrary?: (url: string, responseType: string) => unknown;
        }
      )["_loadLibrary"] = async function (url: string, responseType: string) {
        if (url === "draco_wasm_wrapper.js" && responseType === "text") {
          return dracoWasmWrapperJs;
        } else if (url === "draco_decoder.wasm" && responseType === "arraybuffer") {
          return await (await fetch(dracoDecoderWasmUrl)).arrayBuffer();
        } else {
          throw new Error(
            `DRACOLoader attempt to load non-bundled asset: ${url} as ${responseType}`,
          );
        }
      };
      this.#dracoLoader = dracoLoader;
    }

    dracoLoader.manager = manager;
    return dracoLoader;
  }

  public dispose(): void {
    if (this.#lifetime.signal.aborted) {
      return;
    }
    this.#lifetime.abort();
    this.#models.clear();
    disposeCachedModels(this.#loadedModels);
    this.#loadedModels.clear();
    this.#colladaTextureObjectUrls.forEach((objectUrl) => {
      URL.revokeObjectURL(objectUrl);
    });
    this.#colladaTextureObjectUrls.clear();
    // DRACOLoader is only loader that needs to be disposed because it uses a webworker
    this.#dracoLoader?.dispose();
    this.#dracoLoader = undefined;
  }

  #assertActive(): void {
    if (this.#lifetime.signal.aborted) {
      throw new Error("Model cache is disposed");
    }
  }
}

/** Cached geometries and texture maps are shared by leaf instances. */
function disposeCachedModels(models: Iterable<LoadedModel>): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const model of models) {
    model.traverse((child) => {
      if (
        child instanceof THREE.Mesh ||
        child instanceof THREE.Line ||
        child instanceof THREE.Points
      ) {
        const geometry = child.geometry as THREE.BufferGeometry;
        const childMaterials = child.material as THREE.Material | THREE.Material[];
        geometries.add(geometry);
        for (const material of Array.isArray(childMaterials) ? childMaterials : [childMaterials]) {
          materials.add(material);
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) {
              textures.add(value);
            }
          }
        }
      }
    });
  }
  geometries.forEach((geometry) => {
    geometry.dispose();
  });
  materials.forEach((material) => {
    material.dispose();
  });
  textures.forEach((texture) => {
    texture.dispose();
  });
}

export const EDGE_LINE_SEGMENTS_NAME = "edges";

function fixDaeMaterials(model: LoadedModel): LoadedModel {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    if (child.material instanceof THREE.MeshLambertMaterial) {
      const material = toStandard(child.material);
      child.material.dispose();
      child.material = material;
    } else if (child.material instanceof THREE.MeshStandardMaterial) {
      child.material.dithering = true;
    }
  });
  return model;
}

function fixObjMaterials(model: LoadedModel): LoadedModel {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    if (child.material instanceof THREE.MeshPhongMaterial) {
      const material = toStandard(child.material);
      child.material.dispose();
      child.material = material;
    } else if (child.material instanceof THREE.MeshStandardMaterial) {
      child.material.metalness = 0;
      child.material.roughness = 1;
      child.material.dithering = true;
    }
  });
  return model;
}

function toStandard(
  material: THREE.MeshPhongMaterial | THREE.MeshLambertMaterial,
): THREE.MeshStandardMaterial {
  const standard = new THREE.MeshStandardMaterial({ name: material.name });
  const shininess = (material as Partial<THREE.MeshPhongMaterial>).shininess ?? 0; // [0-100]

  // MeshStandardMaterial.copy() assumes the normalScale property exists, which
  // is true for other MeshStandardMaterials or MeshPhongMaterial but not
  // MeshLambertMaterial. Default initialize this property if needed so the
  // `standard.copy(material)` below succeeds
  const maybePhong = material as Partial<THREE.MeshPhongMaterial>;
  maybePhong.normalScale ??= new THREE.Vector2(1, 1);

  standard.copy(material);
  standard.metalness = 0;
  standard.roughness = 1 - shininess / 100;
  standard.dithering = true;
  return standard;
}

// The THREE.TextureLoader does not support loading .tiff files into textures. To work around
// this we rewrite any `package://` url pointing at a .tiff file into a url which returns a png.
// The x-foxglove-converted-tiff protocol is used because the electron protocol handler for
// package:// uses registerFileProtocol and for converted tiff we need registerBufferProtocol
function rewriteUrl(url: string): string {
  if (url.startsWith("package://") && /\.tiff?$/i.test(url)) {
    return url.replace("package://", "x-foxglove-converted-tiff://");
  }
  return url;
}

function unrewriteUrl(url: string): string {
  if (url.startsWith("x-foxglove-converted-tiff://")) {
    return url.replace("x-foxglove-converted-tiff://", "package://");
  }
  return url;
}

function baseUrl(url: string): string {
  return url.slice(0, url.lastIndexOf("/") + 1);
}
