// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import type { IRenderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";
import { SceneExtension } from "@lichtblick/suite-base/panels/ThreeDeeRender/SceneExtension";
import type { Markers } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/Markers";
import type { PoseArrays } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PoseArrays";
import type { Urdfs } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/Urdfs";
import type { RenderableMarker } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/markers/RenderableMarker";
import type { Marker } from "@lichtblick/suite-base/panels/ThreeDeeRender/ros";

import { activeTrack, trackOpacity, type Track } from "./scene";

export type NativeScene = { markers?: Markers; urdfs?: Urdfs; paths?: PoseArrays };
/** Edits operate on the existing native renderables after their TF/lifetime update. */
export class OfflineEdits extends SceneExtension {
  public time = 0n;
  readonly #sourceMarkers = new WeakMap<RenderableMarker, { source: Marker; applied: Marker }>();
  readonly #opacity = new WeakMap<THREE.Material, number>();
  readonly #wireframe = new WeakMap<THREE.Material, boolean>();
  public constructor(
    renderer: IRenderer,
    private readonly tracks: readonly Track[],
    private readonly native: NativeScene,
  ) {
    super("xgc2.OfflineEdits", renderer);
  }
  public override startFrame(): void {
    for (const topic of this.native.markers?.renderables.values() ?? []) {
      for (const namespace of topic.namespaces.values()) {
        for (const marker of namespace.markersById.values()) {
          const candidates = this.tracks.filter(
            (track): track is Extract<Track, { kind: "markers" }> =>
              track.kind === "markers" &&
              track.selector.topic === topic.topic &&
              (track.selector.kind === "topic" ||
                (track.selector.namespace === namespace.namespace &&
                  track.selector.id === marker.userData.marker.id)),
          );
          if (candidates.length === 0) {
            continue;
          }
          const track = activeTrack(candidates, this.time);
          if (track == undefined) {
            marker.visible = false;
            continue;
          }
          const previous = this.#sourceMarkers.get(marker);
          const source =
            previous?.applied === marker.userData.originalMarker
              ? previous.source
              : marker.userData.originalMarker;
          const alpha = trackOpacity(track, this.time);
          const rgb = track.style.color;
          const color =
            rgb == undefined
              ? { ...source.color, a: source.color.a * alpha }
              : {
                  r: parseInt(rgb.slice(1, 3), 16) / 255,
                  g: parseInt(rgb.slice(3, 5), 16) / 255,
                  b: parseInt(rgb.slice(5, 7), 16) / 255,
                  a: alpha,
                };
          const applied: Marker = {
            ...source,
            color,
            colors:
              rgb == undefined
                ? source.colors.map((value) => ({ ...value, a: value.a * alpha }))
                : [],
            scale: {
              x: source.scale.x * track.style.scale,
              y: source.scale.y * track.style.scale,
              z: source.scale.z * track.style.scale,
            },
          };
          marker.update(applied, undefined);
          this.#sourceMarkers.set(marker, { source, applied });
          marker.visible = marker.visible && alpha > 0;
          marker.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) {
              return;
            }
            const materialValue = (object as THREE.Mesh).material;
            const materials = Array.isArray(materialValue) ? materialValue : [materialValue];
            for (const material of materials) {
              if ("wireframe" in material) {
                const original = this.#wireframe.get(material) ?? Boolean(material.wireframe);
                this.#wireframe.set(material, original);
                material.wireframe =
                  track.style.presentation === "recorded"
                    ? original
                    : track.style.presentation === "wireframe";
              }
            }
          });
        }
      }
    }
    for (const track of this.tracks) {
      if (track.kind !== "robot-model") {
        continue;
      }
      const model = this.native.urdfs?.renderables.get(track.id);
      if (model == undefined) {
        continue;
      }
      const alpha = trackOpacity(track, this.time);
      model.visible = model.visible && alpha > 0;
      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) {
          return;
        }
        const materialValue = (object as THREE.Mesh).material;
        const materials = Array.isArray(materialValue) ? materialValue : [materialValue];
        for (const material of materials) {
          const original = this.#opacity.get(material) ?? Number(material.opacity);
          this.#opacity.set(material, original);
          material.opacity = original * alpha;
          material.transparent = true;
          material.depthWrite = material.opacity >= 1;
        }
      });
    }
  }
}
