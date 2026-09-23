// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** @jest-environment node */

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
