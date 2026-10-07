// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import type { UrdfRobot } from "@lichtblick/den/urdf";

import {
  URDF_LOD_HIGH_MIN_PX,
  URDF_LOD_HYSTERESIS,
  URDF_LOD_MEDIUM_MIN_PX,
  deriveUrdfTierUrl,
  deriveUrdfTierUrlsFromContent,
  deriveUrdfTierUrlsFromUrl,
  selectUrdfLodTier,
  urdfModelBoundingRadius,
  urdfScreenSizePx,
  urdfTierFromUrl,
  UrdfLodTier,
} from "./urdfLod";

describe("deriveUrdfTierUrl", () => {
  const scoutBase = "https://assets.local/packages/scout_description/urdf/scout_visual.urdf";
  const fs150Base = "https://assets.local/packages/fs150_description/urdf/fs150_visual.urdf";

  it("derives the scout tier set from the default URDF", () => {
    expect(deriveUrdfTierUrlsFromUrl(scoutBase)?.tiers).toEqual({
      high: "https://assets.local/packages/scout_description/urdf/scout_visual_lod10k.urdf",
      medium: "https://assets.local/packages/scout_description/urdf/scout_visual_lod_medium.urdf",
      low: "https://assets.local/packages/scout_description/urdf/scout_visual_lod1500.urdf",
    });
  });

  it("derives the fs150 tier set from the default URDF", () => {
    expect(deriveUrdfTierUrlsFromUrl(fs150Base)?.tiers).toEqual({
      high: "https://assets.local/packages/fs150_description/urdf/fs150_visual_lod10k.urdf",
      medium: "https://assets.local/packages/fs150_description/urdf/fs150_visual_lod_medium.urdf",
      low: "https://assets.local/packages/fs150_description/urdf/fs150_visual_lod1500.urdf",
    });
  });

  it("normalizes a tier URL as input to the same sibling set", () => {
    const fromTier = deriveUrdfTierUrlsFromUrl(
      "https://assets.local/packages/scout_description/urdf/scout_visual_lod_medium.urdf",
    );
    expect(fromTier?.tiers).toEqual(deriveUrdfTierUrlsFromUrl(scoutBase)?.tiers);
  });

  it("keeps file:// URLs working for desktop file sources", () => {
    expect(deriveUrdfTierUrl("file:///home/u/urdf/scout_visual.urdf", "low")).toBe(
      "file:///home/u/urdf/scout_visual_lod1500.urdf",
    );
  });

  it("returns undefined for non-URDF and invalid URLs", () => {
    expect(deriveUrdfTierUrlsFromUrl("https://assets.local/packages/scout_description")).toBeUndefined();
    expect(deriveUrdfTierUrlsFromUrl("not a url")).toBeUndefined();
  });

  it("does not treat _detail as a tier", () => {
    expect(
      urdfTierFromUrl("https://assets.local/packages/scout_description/urdf/scout_visual_detail.urdf"),
    ).toBeUndefined();
  });
});

describe("urdfTierFromUrl", () => {
  it.each<[string, UrdfLodTier | undefined]>([
    ["https://x/urdf/scout_visual_lod10k.urdf", "high"],
    ["https://x/urdf/scout_visual_lod_medium.urdf", "medium"],
    ["https://x/urdf/scout_visual_lod1500.urdf", "low"],
    ["https://x/urdf/scout_visual.urdf", undefined],
    ["https://x/urdf/scout.urdf", undefined],
  ])("maps %s to %s", (url, tier) => {
    expect(urdfTierFromUrl(url)).toBe(tier);
  });
});

describe("deriveUrdfTierUrlsFromContent", () => {
  const paramUrdf = `<robot name="scout">
    <link name="base_link">
      <visual><geometry><mesh filename="package://scout_description/meshes/body.stl"/></geometry></visual>
    </link>
  </robot>`;

  it("derives package:// tier URLs from the mesh description package", () => {
    expect(deriveUrdfTierUrlsFromContent(paramUrdf)?.tiers).toEqual({
      high: "package://scout_description/urdf/scout_visual_lod10k.urdf",
      medium: "package://scout_description/urdf/scout_visual_lod_medium.urdf",
      low: "package://scout_description/urdf/scout_visual_lod1500.urdf",
    });
  });

  it.each([
    ["fs150", "fs150_photo"],
    ["scout", "xgc2_scout_mini_visual"],
    ["mecanum", "xgc2_mecanum_ugv"],
    ["b2arx", "b2arx"],
  ])("uses %s resource paths independently of XML name %s and comments", (resource, robotName) => {
    const urdf = `<!-- mesh paths use package://. -->
      <robot name="${robotName}"><link name="base_link"><visual><geometry>
        <mesh filename="package://${resource}_description/meshes/body.dae"/>
      </geometry></visual></link></robot>`;
    expect(deriveUrdfTierUrlsFromContent(urdf)?.tiers).toEqual({
      high: `package://${resource}_description/urdf/${resource}_visual_lod10k.urdf`,
      medium: `package://${resource}_description/urdf/${resource}_visual_lod_medium.urdf`,
      low: `package://${resource}_description/urdf/${resource}_visual_lod1500.urdf`,
    });
  });

  it("returns undefined for primitive-only URDFs", () => {
    const primitives = '<robot name="t"><link name="a"><visual><geometry><box size="1 1 1"/></geometry></visual></link></robot>';
    expect(deriveUrdfTierUrlsFromContent(primitives)).toBeUndefined();
  });
});

describe("selectUrdfLodTier", () => {
  const downHigh = URDF_LOD_HIGH_MIN_PX * (1 - URDF_LOD_HYSTERESIS); // 435.2
  const upHigh = URDF_LOD_HIGH_MIN_PX * (1 + URDF_LOD_HYSTERESIS); // 588.8
  const downMedium = URDF_LOD_MEDIUM_MIN_PX * (1 - URDF_LOD_HYSTERESIS); // 108.8
  const upMedium = URDF_LOD_MEDIUM_MIN_PX * (1 + URDF_LOD_HYSTERESIS); // 147.2

  it.each<[number, UrdfLodTier, UrdfLodTier]>([
    // Well inside each band.
    [750, "high", "high"],
    [300, "medium", "medium"],
    [75, "low", "low"],
    // Hysteresis holds the current tier inside the band.
    [500, "high", "high"],
    [500, "medium", "medium"],
    [140, "medium", "medium"],
    [140, "low", "low"],
    // Clear crossings move one or more bands in a single call.
    [downHigh - 1, "high", "medium"],
    [upHigh, "medium", "high"],
    [downMedium - 1, "medium", "low"],
    [upMedium, "low", "medium"],
    [75, "high", "low"],
    [750, "low", "high"],
  ])("size %dpx with current %s selects %s", (size, current, expected) => {
    expect(selectUrdfLodTier(size, current)).toBe(expected);
  });

  it("never thrashes when the size oscillates across a raw threshold", () => {
    // 127/129 px straddle the raw 128px medium entry but sit inside the
    // 108.8–147.2 px hysteresis band: neither side switches.
    for (const size of [127, 129, 127, 129]) {
      expect(selectUrdfLodTier(size, "medium")).toBe("medium");
      expect(selectUrdfLodTier(size, "low")).toBe("low");
    }
    // Same for the 512px boundary with 500/524 px.
    for (const size of [500, 524, 500, 524]) {
      expect(selectUrdfLodTier(size, "high")).toBe("high");
      expect(selectUrdfLodTier(size, "medium")).toBe("medium");
    }
  });
});

describe("urdfScreenSizePx", () => {
  it("projects a bounding sphere through a perspective camera", () => {
    const sizePx = urdfScreenSizePx({
      radius: 0.866,
      distance: 10,
      viewportHeightPx: 1000,
      camera: { kind: "perspective", fovDeg: 60, zoom: 1 },
    });
    expect(sizePx).toBeCloseTo(150, 0);
  });

  it("applies perspective zoom as a linear magnification", () => {
    const sizePx = urdfScreenSizePx({
      radius: 0.866,
      distance: 10,
      viewportHeightPx: 1000,
      camera: { kind: "perspective", fovDeg: 60, zoom: 2 },
    });
    expect(sizePx).toBeCloseTo(300, 0);
  });

  it("projects through an orthographic view height", () => {
    const sizePx = urdfScreenSizePx({
      radius: 1,
      distance: 100,
      viewportHeightPx: 800,
      camera: { kind: "orthographic", height: 4 },
    });
    expect(sizePx).toBeCloseTo(400);
  });

  it("clamps a camera inside the sphere instead of exploding", () => {
    const sizePx = urdfScreenSizePx({
      radius: 1,
      distance: 0,
      viewportHeightPx: 1000,
      camera: { kind: "perspective", fovDeg: 60, zoom: 1 },
    });
    expect(Number.isFinite(sizePx)).toBe(true);
    expect(sizePx).toBeGreaterThan(0);
  });

  it("reports zero for degenerate inputs", () => {
    expect(
      urdfScreenSizePx({
        radius: 0,
        distance: 10,
        viewportHeightPx: 1000,
        camera: { kind: "perspective", fovDeg: 60, zoom: 1 },
      }),
    ).toBe(0);
    expect(
      urdfScreenSizePx({
        radius: 1,
        distance: 10,
        viewportHeightPx: 0,
        camera: { kind: "perspective", fovDeg: 60, zoom: 1 },
      }),
    ).toBe(0);
  });
});

describe("urdfModelBoundingRadius", () => {
  const identityRpy = { x: 0, y: 0, z: 0 };
  const robot: UrdfRobot = {
    name: "test",
    links: new Map([
      [
        "base",
        {
          name: "base",
          visuals: [
            {
              origin: { xyz: { x: 0, y: 0, z: 0 }, rpy: identityRpy },
              geometry: { geometryType: "mesh", filename: "body.stl", scale: { x: 2, y: 2, z: 2 } },
            },
          ],
          colliders: [],
        },
      ],
      [
        "arm",
        {
          name: "arm",
          visuals: [
            {
              origin: { xyz: { x: 0.5, y: 0, z: 0 }, rpy: identityRpy },
              geometry: { geometryType: "box", size: { x: 0.2, y: 0.2, z: 0.2 } },
            },
          ],
          colliders: [],
        },
      ],
    ]),
    joints: new Map([
      [
        "base_to_arm",
        {
          name: "base_to_arm",
          jointType: "fixed",
          origin: { xyz: { x: 1, y: 0, z: 0 }, rpy: identityRpy },
          parent: "base",
          child: "arm",
          axis: { x: 0, y: 0, z: 1 },
        },
      ],
    ]),
    materials: new Map(),
  };

  it("covers chain offsets, visual origins, and geometry extents", () => {
    // base mesh extent: 0.5·|(2,2,2)| = 1.732
    // arm: |joint| 1 + |visual origin| 0.5 + 0.5·|(0.2,0.2,0.2)| ≈ 1.673
    expect(urdfModelBoundingRadius(robot)).toBeCloseTo(Math.sqrt(3), 5);
  });

  it("floors tiny models so they still get a tier", () => {
    const tiny: UrdfRobot = {
      name: "tiny",
      links: new Map([
        [
          "base",
          {
            name: "base",
            visuals: [
              {
                origin: { xyz: { x: 0, y: 0, z: 0 }, rpy: identityRpy },
                geometry: { geometryType: "sphere", radius: 0.01 },
              },
            ],
            colliders: [],
          },
        ],
      ]),
      joints: new Map(),
      materials: new Map(),
    };
    expect(urdfModelBoundingRadius(tiny)).toBe(0.1);
  });
});
