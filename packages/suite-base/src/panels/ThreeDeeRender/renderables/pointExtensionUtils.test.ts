// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { SettingsTreeField, Topic } from "@lichtblick/suite";
import { BasicBuilder } from "@lichtblick/test-builders";

import {
  DEFAULT_POINT_SETTINGS,
  pointCloudMaterial,
  pointSettingsNode,
} from "./pointExtensionUtils";

type SettingsTreeFieldWithOptions = SettingsTreeField & {
  options: { label: string; value: string };
};

// Foxglove messages
const RGBA_OPTION = { label: "RGBA (separate fields)", value: "rgba-fields" };
const FOXGLOVE_POINTCLOUD_DATATYPE = "foxglove.PointCloud";
const VALID_MESSAGE_FIELDS = ["red", "blue", "green", "alpha"];

// ROS messages
const BGR_OPTION_ROS = { label: "BGR (packed)", value: "rgb" };
const BGRA_OPTION_ROS = { label: "BGRA (packed)", value: "rgba" };
const ROS_POINTCLOUD_DATATYPE = "sensor_msgs/PointCloud2";

describe("pointExtensionUtils", () => {
  describe("colorModeFields", () => {
    const createTopic = (topicArgs?: Partial<Topic>): Topic => {
      return {
        name: BasicBuilder.string(),
        schemaName: BasicBuilder.string(),
        ...topicArgs,
      };
    };

    it("should include RGBA color mode when topic schema is valid and contains RGBA fields", () => {
      const mockTopic = createTopic({ schemaName: FOXGLOVE_POINTCLOUD_DATATYPE });

      const panelSettings = pointSettingsNode(mockTopic, VALID_MESSAGE_FIELDS, {});
      const colorMode = panelSettings.fields!.colorMode! as SettingsTreeFieldWithOptions;

      expect(colorMode.options).toEqual(expect.arrayContaining([RGBA_OPTION]));
      expect(colorMode.options).toEqual(
        expect.not.arrayContaining([BGR_OPTION_ROS, BGRA_OPTION_ROS]),
      );
    });

    it("should include RGBA color mode when topic is convertible to a valid schema and contains RGBA fields", () => {
      const mockTopic = createTopic({ convertibleTo: [FOXGLOVE_POINTCLOUD_DATATYPE] });

      const panelSettings = pointSettingsNode(mockTopic, VALID_MESSAGE_FIELDS, {});
      const colorMode = panelSettings.fields!.colorMode! as SettingsTreeFieldWithOptions;

      expect(colorMode.options).toEqual(expect.arrayContaining([RGBA_OPTION]));
      expect(colorMode.options).toEqual(
        expect.not.arrayContaining([BGR_OPTION_ROS, BGRA_OPTION_ROS]),
      );
    });

    it("should not include RGBA color mode when topic has no RGBA fields", () => {
      const mockTopic = createTopic({ convertibleTo: [FOXGLOVE_POINTCLOUD_DATATYPE] });

      const panelSettings = pointSettingsNode(mockTopic, [], {});
      const colorMode = panelSettings.fields!.colorMode! as SettingsTreeFieldWithOptions;

      expect(colorMode.options).toEqual(expect.not.arrayContaining([RGBA_OPTION]));
      expect(colorMode.options).toEqual(
        expect.not.arrayContaining([BGR_OPTION_ROS, BGRA_OPTION_ROS]),
      );
    });

    it("should not include RGBA color mode when topic schema is invalid, even with valid RGBA fields", () => {
      const mockTopic = createTopic();

      const panelSettings = pointSettingsNode(mockTopic, VALID_MESSAGE_FIELDS, {});
      const colorMode = panelSettings.fields!.colorMode! as SettingsTreeFieldWithOptions;

      expect(colorMode.options).toEqual(expect.not.arrayContaining([RGBA_OPTION]));
      expect(colorMode.options).toEqual(
        expect.not.arrayContaining([BGR_OPTION_ROS, BGRA_OPTION_ROS]),
      );
    });

    it("should include BGR and BGRA color modes for ROS PointCloud2 messages", () => {
      const mockTopic = createTopic({ schemaName: ROS_POINTCLOUD_DATATYPE });

      const panelSettings = pointSettingsNode(mockTopic, BasicBuilder.strings(), {});
      const colorMode = panelSettings.fields!.colorMode! as SettingsTreeFieldWithOptions;

      expect(colorMode.options).toEqual(expect.arrayContaining([BGR_OPTION_ROS, BGRA_OPTION_ROS]));
      expect(colorMode.options).toEqual(expect.not.arrayContaining([RGBA_OPTION]));
    });

    it("should include BGR and BGRA color modes for ROS PointCloud2 messages from message converter", () => {
      const mockTopic = createTopic({ convertibleTo: [ROS_POINTCLOUD_DATATYPE] });

      const panelSettings = pointSettingsNode(mockTopic, BasicBuilder.strings(), {});
      const colorMode = panelSettings.fields!.colorMode! as SettingsTreeFieldWithOptions;

      expect(colorMode.options).toEqual(expect.arrayContaining([BGR_OPTION_ROS, BGRA_OPTION_ROS]));
      expect(colorMode.options).toEqual(expect.not.arrayContaining([RGBA_OPTION]));
    });
  });
});

describe("physical point size", () => {
  function compileShader(mode?: "screen" | "world") {
    const material = pointCloudMaterial({
      ...DEFAULT_POINT_SETTINGS,
      pointSize: 0.1,
      pointSizeMode: mode,
    });
    const shader = {
      vertexShader: THREE.ShaderLib.points.vertexShader,
      fragmentShader: THREE.ShaderLib.points.fragmentShader,
      uniforms: {},
    };
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    return { material, shader };
  }

  it("keeps unspecified units in pixels and creates a distinct program for world units", () => {
    const pixels = compileShader();
    const world = compileShader("world");
    expect(pixels.shader.vertexShader).toBe(THREE.ShaderLib.points.vertexShader);
    expect(pixels.material.sizeAttenuation).toBe(false);
    expect(world.material.sizeAttenuation).toBe(false);
    expect(world.material.customProgramCacheKey()).not.toBe(
      pixels.material.customProgramCacheKey(),
    );
  });

  it("projects meter squares with the camera matrix in perspective and orthographic views", () => {
    const { shader } = compileShader("world");
    expect(shader.vertexShader).toContain(
      "gl_PointSize = size * scale * abs(projectionMatrix[1][1]) / abs(gl_Position.w);",
    );
    // Check the injected projection against actual camera matrices: a 0.1 m
    // square halves its footprint when perspective distance doubles; ortho
    // footprint stays independent of distance and follows zoom.
    function footprint(camera: THREE.Camera, distance: number) {
      const clip = new THREE.Vector4(0, 0, -distance, 1).applyMatrix4(camera.projectionMatrix);
      return (0.1 * 500 * Math.abs(camera.projectionMatrix.elements[5]!)) / Math.abs(clip.w);
    }
    const perspective = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    expect(footprint(perspective, 5)).toBeCloseTo(10);
    expect(footprint(perspective, 10)).toBeCloseTo(5);
    const ortho = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    expect(footprint(ortho, 5)).toBeCloseTo(10);
    expect(footprint(ortho, 10)).toBeCloseTo(10);
    ortho.zoom = 2;
    ortho.updateProjectionMatrix();
    expect(footprint(ortho, 10)).toBeCloseTo(20);
  });

  it("offers meter units only to the cloud renderer that implements them", () => {
    const topic = { name: "/map", schemaName: "sensor_msgs/PointCloud2" };
    const world = pointSettingsNode(topic, ["x", "y", "z"], { pointSizeMode: "world" });
    expect(world.fields!.pointSizeMode).toMatchObject({ value: "world" });
    expect(world.fields!.pointSize).toMatchObject({ step: 0.01, placeholder: "0.1" });
    const scan = pointSettingsNode(topic, [], {}, DEFAULT_POINT_SETTINGS, {
      supportsWorldSize: false,
    });
    expect(scan.fields!.pointSizeMode).toBeUndefined();
  });
});
