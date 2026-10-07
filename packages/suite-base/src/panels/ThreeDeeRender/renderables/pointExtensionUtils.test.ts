// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { SettingsTreeField, Topic } from "@lichtblick/suite";
import { BasicBuilder } from "@lichtblick/test-builders";

import type { IRenderer } from "../IRenderer";
import { PointFieldType, type PointCloud2 } from "../ros";
import { makePose } from "../transforms";
import { PointCloudHistoryRenderable, createStixelMaterial } from "./PointClouds";
import * as colorModes from "./colorMode";
import {
  DEFAULT_POINT_SETTINGS,
  createInstancePickingMaterial,
  createPickingMaterial,
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

describe("PointCloud flat buffer updates", () => {
  type CloudSettings = ConstructorParameters<typeof PointCloudHistoryRenderable>[2]["settings"];

  function cloud(values: readonly number[], datatype = PointFieldType.FLOAT32): PointCloud2 {
    const data = new Uint8Array(values.length * 16);
    const view = new DataView(data.buffer);
    values.forEach((value, index) => {
      const offset = index * 16;
      view.setFloat32(offset, index + 1, true);
      view.setFloat32(offset + 4, index + 2, true);
      view.setFloat32(offset + 8, index + 3, true);
      if (datatype === PointFieldType.UINT32) {
        view.setUint32(offset + 12, value, true);
      } else {
        view.setFloat32(offset + 12, value, true);
      }
    });
    return {
      header: { seq: 1, stamp: { sec: 1, nsec: 0 }, frame_id: "world" },
      height: 1,
      width: values.length,
      fields: [
        ...["x", "y", "z"].map((name, index) => ({
          name,
          offset: index * 4,
          datatype: PointFieldType.FLOAT32,
          count: 1,
        })),
        { name: "value", offset: 12, datatype, count: 1 },
      ],
      is_bigendian: false,
      point_step: 16,
      row_step: data.length,
      data,
      is_dense: false,
    };
  }

  function fixture(overrides: Partial<CloudSettings> = {}) {
    const settings: CloudSettings = {
      ...DEFAULT_POINT_SETTINGS,
      visible: true,
      stixelsEnabled: true,
      colorFieldComputed: undefined,
      colorField: "value",
      flatColor: "#80808080",
      ...overrides,
    };
    const errors = jest.fn();
    const renderer = {
      normalizeFrameId: (frameId: string) => frameId,
      settings: { errors: { addToTopic: errors } },
    } as unknown as IRenderer;
    const renderable = new PointCloudHistoryRenderable("/cloud", renderer, {
      receiveTime: 0n,
      messageTime: 0n,
      frameId: "world",
      pose: makePose(),
      settingsPath: ["topics", "/cloud"],
      settings,
      topic: "/cloud",
      latestPointCloud: cloud([]),
      latestOriginalMessage: undefined,
      material: pointCloudMaterial(settings),
      pickingMaterial: createPickingMaterial(settings),
      instancePickingMaterial: createInstancePickingMaterial(settings),
      stixelMaterial: createStixelMaterial(settings),
    });
    return { renderable, settings, errors };
  }

  function geometries(renderable: PointCloudHistoryRenderable) {
    return renderable.children.map(
      (child) => (child as THREE.Object3D & { geometry: THREE.BufferGeometry }).geometry,
    );
  }

  function trackConversions() {
    const original = colorModes.getColorConverter;
    const calls = jest.fn();
    jest.spyOn(colorModes, "getColorConverter").mockImplementation((settings, min, max) => {
      const convert = original(settings, min, max);
      return (output, value) => {
        calls(value);
        convert(output, value);
      };
    });
    return calls;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("decodes flat-color clouds through the fused fast path, preserving every point and stixel", () => {
    const { renderable, settings, errors } = fixture();
    const message = cloud([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    new DataView(message.data.buffer).setFloat32(0, Number.NaN, true);
    const reads = jest.spyOn(DataView.prototype, "getFloat32");
    const conversions = trackConversions();
    renderable.updatePointCloud(message, undefined, settings, 2n);
    // Fast path: positions come from a strided Float32Array view (stride 16 here), so no
    // DataView reads happen at all; the flat color is still converted exactly once
    expect(reads).not.toHaveBeenCalled();
    expect(conversions).toHaveBeenCalledTimes(1);
    const [points, stixels] = geometries(renderable);
    expect(points!.drawRange.count).toBe(3);
    expect(stixels!.drawRange.count).toBe(6);
    expect(points!.attributes.position!.array).toBeInstanceOf(Float32Array);
    expect(points!.attributes.position!.array[0]).toBeNaN();
    expect(Array.from(points!.attributes.position!.array).slice(1)).toEqual([
      2, 3, 2, 3, 4, 3, 4, 5,
    ]);
    expect(points!.attributes.color!.array).toBeInstanceOf(Uint8Array);
    expect(points!.attributes.color!.normalized).toBe(true);
    expect(Array.from(points!.attributes.color!.array)).toEqual([
      55, 55, 55, 128, 55, 55, 55, 128, 55, 55, 55, 128,
    ]);
    expect(Array.from(stixels!.attributes.color!.array)).toEqual(
      Array(6).fill([55, 55, 55, 128]).flat(),
    );
    expect(Array.from(stixels!.attributes.position!.array).slice(2, 6)).toEqual([
      3,
      Number.NaN,
      2,
      0,
    ]);
    expect(errors).not.toHaveBeenCalled();
    renderable.dispose();
  });

  it("does not calculate ignored distance or read any values for an empty cloud", () => {
    const { renderable, settings } = fixture({ colorField: "_auto_distance" });
    const reads = jest.spyOn(DataView.prototype, "getFloat32");
    const hypot = jest.spyOn(Math, "hypot");
    const conversions = trackConversions();
    renderable.updatePointCloud(cloud([1, 2, 3]), undefined, settings, 1n);
    // The computed distance color field excludes the fast path, so the per-point reader loop runs
    expect(reads).toHaveBeenCalledTimes(9);
    expect(hypot).not.toHaveBeenCalled();
    expect(conversions).toHaveBeenCalledTimes(1);
    reads.mockClear();
    conversions.mockClear();
    renderable.updatePointCloud(cloud([]), undefined, settings, 2n);
    expect(reads).not.toHaveBeenCalled();
    expect(conversions).not.toHaveBeenCalled();
    expect(geometries(renderable).map((geometry) => geometry.drawRange.count)).toEqual([0, 0]);
    renderable.dispose();
  });

  it("decodes packed RGB through the fused fast path with original sRGB bytes and alpha", () => {
    const { renderable, settings } = fixture({ colorMode: "rgb", explicitAlpha: 0.5 });
    const reads = jest.spyOn(DataView.prototype, "getUint32");
    const conversions = trackConversions();
    renderable.updatePointCloud(
      cloud([0xff0000, 0x00ff00, 0x0000ff], PointFieldType.UINT32),
      undefined,
      settings,
      1n,
    );
    // Fast path: packed colors are extracted from a Uint32Array view, so neither per-point
    // DataView reads nor color converter calls happen
    expect(reads).not.toHaveBeenCalled();
    expect(conversions).not.toHaveBeenCalled();
    const [points, stixels] = geometries(renderable);
    expect(Array.from(points!.attributes.color!.array)).toEqual([
      255, 0, 0, 128, 0, 255, 0, 128, 0, 0, 255, 128,
    ]);
    expect(Array.from(stixels!.attributes.color!.array)).toEqual([
      255, 0, 0, 128, 255, 0, 0, 128, 0, 255, 0, 128, 0, 255, 0, 128, 0, 0, 255, 128, 0, 0, 255,
      128,
    ]);
    renderable.dispose();
  });

  it("produces byte-identical buffers to the reader loop for packed RGBA clouds, including NaN positions", () => {
    // The same logical cloud in a fast layout (contiguous float32 x/y/z at offsets 0/4/8,
    // stride 16) and a slow one (scattered field offsets force the per-point reader loop)
    const colors = [0x80ff0000, 0x4000ff00, 0xc00000ff];
    const fastMessage = cloud(colors, PointFieldType.UINT32);
    new DataView(fastMessage.data.buffer).setFloat32(0, Number.NaN, true);

    const slowData = new Uint8Array(3 * 24);
    const slowView = new DataView(slowData.buffer);
    for (let index = 0; index < 3; index++) {
      slowView.setFloat32(index * 24, index === 0 ? Number.NaN : index + 1, true);
      slowView.setFloat32(index * 24 + 8, index + 2, true);
      slowView.setFloat32(index * 24 + 16, index + 3, true);
      slowView.setUint32(index * 24 + 20, colors[index]!, true);
    }
    const slowMessage: PointCloud2 = {
      header: { seq: 1, stamp: { sec: 1, nsec: 0 }, frame_id: "world" },
      height: 1,
      width: 3,
      fields: [
        { name: "x", offset: 0, datatype: PointFieldType.FLOAT32, count: 1 },
        { name: "y", offset: 8, datatype: PointFieldType.FLOAT32, count: 1 },
        { name: "z", offset: 16, datatype: PointFieldType.FLOAT32, count: 1 },
        { name: "value", offset: 20, datatype: PointFieldType.UINT32, count: 1 },
      ],
      is_bigendian: false,
      point_step: 24,
      row_step: slowData.length,
      data: slowData,
      is_dense: false,
    };

    const fast = fixture({ colorMode: "rgba" });
    const slow = fixture({ colorMode: "rgba" });
    const floatReads = jest.spyOn(DataView.prototype, "getFloat32");
    const packedReads = jest.spyOn(DataView.prototype, "getUint32");
    fast.renderable.updatePointCloud(fastMessage, undefined, fast.settings, 1n);
    expect(floatReads).not.toHaveBeenCalled();
    expect(packedReads).not.toHaveBeenCalled();
    slow.renderable.updatePointCloud(slowMessage, undefined, slow.settings, 1n);
    expect(floatReads).toHaveBeenCalledTimes(9);
    expect(packedReads).toHaveBeenCalledTimes(3);

    const [fastPoints, fastStixels] = geometries(fast.renderable);
    const [slowPoints, slowStixels] = geometries(slow.renderable);
    expect(Array.from(fastPoints!.attributes.position!.array)).toEqual(
      Array.from(slowPoints!.attributes.position!.array),
    );
    expect(Array.from(fastPoints!.attributes.color!.array)).toEqual(
      Array.from(slowPoints!.attributes.color!.array),
    );
    expect(Array.from(fastStixels!.attributes.position!.array)).toEqual(
      Array.from(slowStixels!.attributes.position!.array),
    );
    expect(Array.from(fastStixels!.attributes.color!.array)).toEqual(
      Array.from(slowStixels!.attributes.color!.array),
    );
    // Spot-check the exact decoded bytes: 0xAARRGGBB packed colors, NaN passthrough in x
    expect(Array.from(fastPoints!.attributes.color!.array)).toEqual([
      255, 0, 0, 128, 0, 255, 0, 64, 0, 0, 255, 192,
    ]);
    expect(fastPoints!.attributes.position!.array[0]).toBeNaN();
    fast.renderable.dispose();
    slow.renderable.dispose();
  });

  it("uploads densely packed stride-12 positions with a single memcpy", () => {
    const { renderable, settings } = fixture();
    const data = new Uint8Array(3 * 12);
    const view = new DataView(data.buffer);
    for (let index = 0; index < 3; index++) {
      view.setFloat32(index * 12, index === 0 ? Number.NaN : index + 1, true);
      view.setFloat32(index * 12 + 4, index + 2, true);
      view.setFloat32(index * 12 + 8, index + 3, true);
    }
    const message: PointCloud2 = {
      header: { seq: 1, stamp: { sec: 1, nsec: 0 }, frame_id: "world" },
      height: 1,
      width: 3,
      fields: ["x", "y", "z"].map((name, index) => ({
        name,
        offset: index * 4,
        datatype: PointFieldType.FLOAT32,
        count: 1,
      })),
      is_bigendian: false,
      point_step: 12,
      row_step: data.length,
      data,
      is_dense: false,
    };
    const memcpy = jest.spyOn(Float32Array.prototype, "set");
    const reads = jest.spyOn(DataView.prototype, "getFloat32");
    renderable.updatePointCloud(message, undefined, settings, 1n);
    expect(memcpy).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    const [points, stixels] = geometries(renderable);
    expect(Array.from(points!.attributes.position!.array)).toEqual([
      Number.NaN, 2, 3, 2, 3, 4, 3, 4, 5,
    ]);
    expect(Array.from(points!.attributes.color!.array)).toEqual([
      55, 55, 55, 128, 55, 55, 55, 128, 55, 55, 55, 128,
    ]);
    expect(Array.from(stixels!.attributes.position!.array)).toEqual([
      Number.NaN, 2, 3, Number.NaN, 2, 0, 2, 3, 4, 2, 3, 0, 3, 4, 5, 3, 4, 0,
    ]);
    renderable.dispose();
  });

  it("retains automatic gradient extrema and per-point reads, including NaN colors", () => {
    const { renderable, settings } = fixture({
      colorMode: "gradient",
      gradient: ["#00000080", "#ffffff80"],
    });
    const reads = jest.spyOn(DataView.prototype, "getFloat32");
    const conversions = trackConversions();
    renderable.updatePointCloud(cloud([0, 5, 10]), undefined, settings, 1n);
    expect(reads).toHaveBeenCalledTimes(15);
    expect(conversions).toHaveBeenCalledTimes(3);
    const [points] = geometries(renderable);
    expect(Array.from(points!.attributes.color!.array)).toEqual([
      0, 0, 0, 128, 64, 64, 64, 128, 128, 128, 128, 128,
    ]);
    reads.mockClear();
    conversions.mockClear();
    renderable.updatePointCloud(cloud([0, Number.NaN, 10]), undefined, settings, 2n);
    expect(reads).toHaveBeenCalledTimes(15);
    expect(conversions).toHaveBeenCalledTimes(3);
    expect(Array.from(points!.attributes.color!.array)).toEqual(Array(12).fill(0));
    renderable.dispose();
  });

  it.each([
    16, -1,
  ])("keeps malformed selected-field offset %s as a visible error before buffer reads", (offset) => {
    const { renderable, settings, errors } = fixture();
    const message = cloud([1]);
    message.fields[3]!.offset = offset;
    const reads = jest.spyOn(DataView.prototype, "getFloat32");
    const conversions = trackConversions();
    renderable.updatePointCloud(message, undefined, settings, 1n);
    expect(errors).toHaveBeenCalledWith(
      "/cloud",
      "INVALID_POINTCLOUD",
      expect.stringContaining("invalid"),
    );
    expect(reads).not.toHaveBeenCalled();
    expect(conversions).not.toHaveBeenCalled();
    expect(geometries(renderable)[0]!.drawRange.count).toBe(0);
    renderable.dispose();
  });

  it("updates flat color after growth, shrinking and retained decay history without changing buffers", () => {
    const { renderable, settings } = fixture({ decayTime: 1 });
    const first = cloud([0]);
    renderable.updatePointCloud(first, undefined, settings, 1n);
    const firstGeometry = geometries(renderable)[0]!;
    renderable.updatePointCloud(cloud([0, 0]), undefined, settings, 1n);
    expect(geometries(renderable)[0]).toBe(firstGeometry);
    expect(firstGeometry.drawRange.count).toBe(2);
    const preservedColors = Array.from(firstGeometry.attributes.color!.array);
    const next = cloud([0, 0, 0]);
    const nextSettings = { ...settings, flatColor: "#ff000040" };
    renderable.pushHistory(next, undefined, nextSettings, 2n);
    renderable.updatePointCloud(next, undefined, nextSettings, 2n);
    const history = geometries(renderable);
    expect(history).toHaveLength(4);
    expect(history[0]).toBe(firstGeometry);
    expect(Array.from(firstGeometry.attributes.color!.array)).toEqual(preservedColors);
    expect(Array.from(history[2]!.attributes.color!.array)).toEqual([
      255, 0, 0, 64, 255, 0, 0, 64, 255, 0, 0, 64,
    ]);
    const noStixels = { ...nextSettings, stixelsEnabled: false };
    renderable.updatePointCloud(cloud([0]), undefined, noStixels, 3n);
    expect(history[2]!.drawRange.count).toBe(1);
    expect(history[2]!.attributes.position!.array).toBeInstanceOf(Float32Array);
    expect(history[2]!.attributes.color!.array).toBeInstanceOf(Uint8Array);
    expect(history[3]!.drawRange.count).toBe(0);
    expect(Array.from(history[2]!.attributes.color!.array).slice(0, 4)).toEqual([255, 0, 0, 64]);
    renderable.dispose();
  });
});
