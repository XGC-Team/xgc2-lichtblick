// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** @jest-environment node */

import * as THREE from "three";
import {
  parseVisualManifest,
  projectedVisualError,
  selectVisualVariant,
  visualVariantUri,
} from "./urdfVisualLod";
import { customUrdfLayerNeedsReload, urdfLayerDisplayScale } from "./customUrdfLayer";

describe("urdfLayerDisplayScale", () => {
  it("falls back to true size for missing or invalid values", () => {
    expect(urdfLayerDisplayScale(undefined)).toBe(1);
    expect(urdfLayerDisplayScale({})).toBe(1);
    expect(urdfLayerDisplayScale({ scale: 0 })).toBe(1);
    expect(urdfLayerDisplayScale({ scale: -2 })).toBe(1);
    expect(urdfLayerDisplayScale({ scale: Number.NaN })).toBe(1);
    expect(urdfLayerDisplayScale({ scale: "3" })).toBe(1);
  });

  it("keeps a positive finite factor", () => {
    expect(urdfLayerDisplayScale({ scale: 2.5 })).toBe(2.5);
  });
});

describe("customUrdfLayerNeedsReload", () => {
  const mecanum = "<robot name='mecanum'/>";

  it("keeps a parked layer when XML, prefix, and parameter are unchanged", () => {
    expect(
      customUrdfLayerNeedsReload(
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/ugv2/",
          parameter: "/ugv2/visual_robot_description",
        },
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/ugv2/",
          parameter: "/ugv2/visual_robot_description",
        },
      ),
    ).toBe(false);
  });

  it("reloads when a Scout scene-model alias is replaced by the mecanum slot name", () => {
    expect(
      customUrdfLayerNeedsReload(
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/ugv3/",
          parameter: "/ugv2/visual_robot_description",
        },
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/ugv2/",
          parameter: "/ugv2/visual_robot_description",
        },
      ),
    ).toBe(true);
  });

  it("reloads when the parameter identity changes even if XML is identical", () => {
    expect(
      customUrdfLayerNeedsReload(
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/ugv2/",
          parameter: "/ugv3/visual_robot_description",
        },
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/ugv2/",
          parameter: "/ugv2/visual_robot_description",
        },
      ),
    ).toBe(true);
  });

  it("honors forceReload", () => {
    const same = {
      urdf: mecanum,
      framePrefix: "xgc/robots/ugv1/",
      parameter: "/ugv1/visual_robot_description",
    };
    expect(customUrdfLayerNeedsReload(same, same, { forceReload: true })).toBe(true);
  });

  it("reloads when the display scale changes even if XML is identical", () => {
    expect(
      customUrdfLayerNeedsReload(
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/uav1/",
          parameter: "/uav1/visual_robot_description",
          scale: 1,
        },
        {
          urdf: mecanum,
          framePrefix: "xgc/robots/uav1/",
          parameter: "/uav1/visual_robot_description",
          scale: 3,
        },
      ),
    ).toBe(true);
  });
});

describe("declared visual URDF screen policy", () => {
  const manifest = {
    release_visual: "release",
    variants: {
      detail: { urdf: "urdf/detail.urdf" },
      release: { urdf: "urdf/release.urdf" },
      proxy: { urdf: "urdf/proxy.urdf" },
    },
    viewer_lod: {
      reference: "detail",
      metric: "sampled_surface_m" as const,
      errors: { detail: 0, release: 0.3, proxy: 0.8 },
      link_roles: {},
    },
  };
  it("keeps unmeasured release errors unknown and resolves only the explicit package table", () => {
    const value = parseVisualManifest(
      JSON.stringify({
        ...manifest,
        viewer_lod: { ...manifest.viewer_lod, errors: { detail: 0 } },
      }),
    );
    expect(selectVisualVariant(value, "release", (metres) => metres, false)).toBe("release");
    expect(selectVisualVariant(value, "release", () => undefined, true)).toBe("detail");
    expect(
      visualVariantUri("package://description/modeling/visual_variants.json", value, "release"),
    ).toBe("package://description/urdf/release.urdf");
    expect(() =>
      parseVisualManifest(
        JSON.stringify({
          ...manifest,
          viewer_lod: { ...manifest.viewer_lod, errors: { detail: 0, foreign: 0 } },
        }),
      ),
    ).toThrow();
  });
  it("uses separate engineering refinement/coarsening thresholds without distance or fleet branches", () => {
    expect(selectVisualVariant(manifest, "release", (metres) => metres * 2, false)).toBe("release");
    expect(selectVisualVariant(manifest, "release", (metres) => metres * 0.5, false)).toBe("proxy");
    expect(selectVisualVariant(manifest, "proxy", (metres) => metres * 2, false)).toBe("detail");
    expect(selectVisualVariant(manifest, "proxy", () => undefined, false)).toBe("detail");
  });
  it("uses the actual drawing pixels and view projection, with unreliable near-plane estimates rejected", () => {
    const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
    camera.updateMatrixWorld();
    const center = new THREE.Vector3(0, 0, -10);
    const low = projectedVisualError(camera, new THREE.Vector2(400, 400), center, 1, 0.001)!;
    const high = projectedVisualError(camera, new THREE.Vector2(800, 800), center, 1, 0.001)!;
    expect(high).toBeCloseTo(low * 2);
    expect(projectedVisualError(camera, new THREE.Vector2(400, 400), center, 1, 0.002)).toBeCloseTo(
      low * 2,
    );
    expect(
      projectedVisualError(
        camera,
        new THREE.Vector2(400, 400),
        new THREE.Vector3(0, 0, -0.2),
        1,
        0.001,
      ),
    ).toBeUndefined();
  });
});
