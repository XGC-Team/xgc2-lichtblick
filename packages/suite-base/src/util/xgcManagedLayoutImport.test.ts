/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LayoutData } from "@lichtblick/suite-base/context/CurrentLayoutContext";

import { sanitizeImportedLayoutData, sanitizeImportedPanelConfig } from "./xgcManagedLayoutImport";

const authorityThreeD = {
  followTf: "world",
  followMode: "follow-none",
  topics: {
    "/xgc/tf": { visible: true },
    "/xgc/scene": { visible: true, showOutlines: false },
  },
  transforms: { "frame:world": { visible: true } },
  scene: { meshUpAxis: "z_up", obstacleScene: { namespace: "/xgc/scene" } },
  layers: {
    "xgc2-grid": { layerId: "foxglove.Grid", visible: true },
    "xgc2-urdf-uav1": { layerId: "foxglove.Urdf", parameter: "/uav1/visual_robot_description" },
  },
  cameraState: { distance: 12, target: [0, 0, 0] },
};

const authorityImage = {
  imageMode: {
    imageTopic: "/xgc/camera/world/video_h264",
    calibrationTopic: "/xgc/camera/world/camera_info",
    rotation: 0,
  },
  topics: { "/xgc/scene": { visible: true } },
  layers: {
    "xgc2-urdf-uav1": { layerId: "foxglove.Urdf", parameter: "/uav1/visual_robot_description" },
  },
  cameraState: { distance: 8 },
};

const authorityLayout: LayoutData = {
  configById: {
    "3D!xgc2": authorityThreeD,
    "Image!xgc2-camera-ar": authorityImage,
  },
  globalVariables: {},
  userNodes: {},
  playbackConfig: { speed: 1 },
  layout: {
    first: "3D!xgc2",
    second: "Image!xgc2-camera-ar",
    direction: "column",
  },
};

describe("xgc managed layout import", () => {
  it("keeps camera, mosaic, theme-like presentation and restores managed wiring", () => {
    const incoming = {
      configById: {
        "3D!imported": {
          followTf: "base_link",
          followMode: "follow-pose",
          topics: {
            "/xgc/tf": { visible: false },
            "/foreign/pose": { visible: true },
          },
          transforms: { "frame:map": { visible: true } },
          scene: { meshUpAxis: "y_up", obstacleScene: { namespace: "/attacker" } },
          layers: {
            "xgc2-grid": { layerId: "foxglove.Grid", color: "#111111", visible: true },
            "xgc2-urdf-uav1": { parameter: "/robot_description" },
            "user-points": { layerId: "foxglove.PointCloud" },
          },
          cameraState: { distance: 4, target: [1, 2, 3] },
        },
        "Image!imported": {
          imageMode: {
            imageTopic: "/usb_cam/hijack",
            calibrationTopic: "/wrong/info",
            rotation: 90,
          },
          topics: { "/xgc/scene": { visible: false }, "/other": { visible: true } },
          layers: { "xgc2-urdf-uav1": { parameter: "/robot_description" } },
          cameraState: { distance: 3 },
        },
        "Plot!xgc2-plot": { paths: [{ value: "/topic.field" }] },
      },
      layout: {
        first: "3D!imported",
        second: "Image!imported",
        direction: "row",
      },
      globalVariables: { theme: "keep" },
      userNodes: {},
      playbackConfig: { speed: 2 },
    };

    const sanitized = sanitizeImportedLayoutData(incoming, authorityLayout) as LayoutData;
    expect(sanitized.layout).toEqual(incoming.layout);
    expect(sanitized.globalVariables).toEqual({ theme: "keep" });
    expect(sanitized.configById["3D!imported"]).toMatchObject({
      followTf: "world",
      followMode: "follow-none",
      topics: { "/xgc/tf": { visible: false }, "/xgc/scene": { visible: true, showOutlines: false } },
      transforms: { "frame:world": { visible: true } },
      scene: { meshUpAxis: "y_up", obstacleScene: { namespace: "/xgc/scene" } },
      layers: {
        "xgc2-grid": { layerId: "foxglove.Grid", color: "#111111", visible: true },
        "xgc2-urdf-uav1": { layerId: "foxglove.Urdf", parameter: "/uav1/visual_robot_description" },
        "user-points": { layerId: "foxglove.PointCloud" },
      },
      cameraState: { distance: 4, target: [1, 2, 3] },
    });
    expect(sanitized.configById["3D!imported"]?.topics).not.toHaveProperty("/foreign/pose");
    expect(sanitized.configById["Image!imported"]).toMatchObject({
      imageMode: {
        imageTopic: "/xgc/camera/world/video_h264",
        calibrationTopic: "/xgc/camera/world/camera_info",
        rotation: 90,
      },
      topics: { "/xgc/scene": { visible: false } },
      layers: {
        "xgc2-urdf-uav1": { layerId: "foxglove.Urdf", parameter: "/uav1/visual_robot_description" },
      },
      cameraState: { distance: 3 },
    });
    expect(sanitized.configById["Image!imported"]?.topics).not.toHaveProperty("/other");
    expect(sanitized.configById["Plot!xgc2-plot"]).toEqual({ paths: [{ value: "/topic.field" }] });
  });

  it("replaces a parked Scout ugv3 URDF layer with the mecanum ugv2 authority layer", () => {
    const authority = {
      ...authorityThreeD,
      layers: {
        "xgc2-grid": { layerId: "foxglove.Grid", visible: true },
        "xgc2-urdf-ugv1": {
          layerId: "foxglove.Urdf",
          parameter: "/ugv1/visual_robot_description",
          framePrefix: "xgc/robots/ugv1/",
        },
        "xgc2-urdf-ugv2": {
          layerId: "foxglove.Urdf",
          parameter: "/ugv2/visual_robot_description",
          framePrefix: "xgc/robots/ugv2/",
        },
      },
    };
    const imported = sanitizeImportedPanelConfig(
      {
        layers: {
          "xgc2-grid": { layerId: "foxglove.Grid", color: "#111111" },
          "xgc2-urdf-ugv2": {
            layerId: "foxglove.Urdf",
            parameter: "/ugv2/visual_robot_description",
            framePrefix: "xgc/robots/ugv3/",
          },
          "xgc2-urdf-ugv3": {
            layerId: "foxglove.Urdf",
            parameter: "/ugv3/visual_robot_description",
            framePrefix: "xgc/robots/ugv3/",
          },
        },
      },
      authority,
      "3D",
    );
    expect(imported.layers).toEqual({
      "xgc2-grid": { layerId: "foxglove.Grid", color: "#111111" },
      "xgc2-urdf-ugv1": {
        layerId: "foxglove.Urdf",
        parameter: "/ugv1/visual_robot_description",
        framePrefix: "xgc/robots/ugv1/",
      },
      "xgc2-urdf-ugv2": {
        layerId: "foxglove.Urdf",
        parameter: "/ugv2/visual_robot_description",
        framePrefix: "xgc/robots/ugv2/",
      },
    });
  });

  it("does not let panel JSON invent a second robot or camera identity", () => {
    const imported = sanitizeImportedPanelConfig(
      {
        followTf: "map",
        topics: { "/tf": { visible: true } },
        scene: { obstacleScene: { namespace: "/other" } },
      },
      authorityThreeD,
      "3D",
    );
    expect(imported.followTf).toBe("world");
    expect(imported.topics).toEqual({
      "/xgc/tf": { visible: true },
      "/xgc/scene": { visible: true, showOutlines: false },
    });
    expect((imported.scene as { obstacleScene: { namespace: string } }).obstacleScene.namespace).toBe(
      "/xgc/scene",
    );
  });

  it("passes through layouts that are not panel config objects", () => {
    const raw = { data: "not-a-layout" };
    expect(sanitizeImportedLayoutData(raw, authorityLayout)).toEqual(raw);
  });
});
