// SPDX-FileCopyrightText: Copyright (C) 2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { NumericType, PackedElementField, PointCloud } from "@foxglove/schemas";
import * as THREE from "three";
import type { Time } from "@lichtblick/rostime";
import type { DeepPartial } from "ts-essentials";
import {
  normalizeByteArray,
  normalizeHeader,
  normalizeTime,
  normalizePose,
  numericTypeToPointFieldType,
} from "../../normalizeMessages";
import { PointCloud2, PointField, PointFieldType } from "../../ros";
import { makePose, type Pose } from "../../transforms";
import { getColorConverter, colorFieldComputedPrefix, autoSelectColorSettings } from "../colorMode";
import type { LayerSettingsPointClouds } from "../PointClouds";
import { type FieldReader, getReader, isSupportedField } from "./fieldReaders";

type PartialMessage<T> = DeepPartial<T>;
const NEEDS_MIN_MAX = ["gradient", "colormap"];
const tempColor = { r: 0, g: 0, b: 0, a: 0 };
const tempMinMaxColor: THREE.Vector2Tuple = [0, 0];
type PointCloudFieldReaders = {
  xReader: FieldReader;
  yReader: FieldReader;
  zReader: FieldReader;
  packedColorReader: FieldReader;
  redReader: FieldReader;
  greenReader: FieldReader;
  blueReader: FieldReader;
  alphaReader: FieldReader;
};

export type PreparedPointCloud = {
  pointCloud: PointCloud | PointCloud2;
  pointCount: number;
  coordinatesPrepared: boolean;
  positions: Float32Array;
  colors: Uint8Array;
  stixelPositions: Float32Array;
  stixelColors: Uint8Array;
  bounds: { min: readonly number[]; max: readonly number[] } | undefined;
  problems: string[];
  settings: LayerSettingsPointClouds;
};

/** Pure CPU derivation shared by the dedicated prep worker and the original ordered path. */
export function preparePointCloud(
  message: unknown,
  schemaName: string,
  settings: LayerSettingsPointClouds,
  capacity: number,
  deriveCoordinates = true,
  onAllocated?: (arrays: readonly ArrayBufferView[]) => void,
): PreparedPointCloud {
  const cloud = schemaName.includes("PointCloud2")
    ? normalizePointCloud2(message as PartialMessage<PointCloud2>)
    : normalizePointCloud(message as PartialMessage<PointCloud>);
  onAllocated?.([cloud.data]);
  const effective = { ...settings };
  if (effective.colorField == undefined)
    autoSelectColorSettings(
      effective,
      cloud.fields.filter(isSupportedField).map((f) => f.name),
      {
        supportsPackedRgbModes: schemaName.includes("PointCloud2"),
        supportsRgbaFieldsMode: !schemaName.includes("PointCloud2"),
      },
    );
  if (effective.colorField === colorFieldComputedPrefix + "distance")
    effective.colorFieldComputed = "distance";
  return prepareNormalizedPointCloud(cloud, effective, capacity, deriveCoordinates, onAllocated);
}

export function prepareNormalizedPointCloud(
  cloud: PointCloud | PointCloud2,
  settings: LayerSettingsPointClouds,
  capacity: number,
  deriveCoordinates = true,
  onAllocated?: (arrays: readonly ArrayBufferView[]) => void,
): PreparedPointCloud {
  return new PointCloudCpuPreparer().prepare(
    cloud,
    settings,
    capacity,
    deriveCoordinates,
    onAllocated,
  );
}

export function validateNormalizedPointCloud(
  cloud: PointCloud | PointCloud2,
  settings: LayerSettingsPointClouds,
): void {
  new PointCloudCpuPreparer().validate(cloud, settings);
}

export function updateNormalizedPointCloudBuffers(
  cloud: PointCloud | PointCloud2,
  settings: LayerSettingsPointClouds,
  position: THREE.BufferAttribute,
  color: THREE.BufferAttribute,
  stixelPosition: THREE.BufferAttribute,
  stixelColor: THREE.BufferAttribute,
): { bounds: PreparedPointCloud["bounds"]; problems: string[] } {
  const preparer = new PointCloudCpuPreparer();
  preparer.fill(cloud, settings, position, color, stixelPosition, stixelColor);
  return { bounds: preparer.bounds, problems: preparer.problems };
}

class PointCloudCpuPreparer {
  public problems: string[] = [];
  #invalidError(message: string): never {
    throw new Error(message);
  }
  public prepare(
    pointCloud: PointCloud | PointCloud2,
    settings: LayerSettingsPointClouds,
    capacity: number,
    deriveCoordinates = true,
    onAllocated?: (arrays: readonly ArrayBufferView[]) => void,
  ): PreparedPointCloud {
    this.#validatePointCloud(pointCloud);
    const readers: PointCloudFieldReaders = {
      xReader: zeroReader,
      yReader: zeroReader,
      zReader: zeroReader,
      packedColorReader: zeroReader,
      redReader: zeroReader,
      greenReader: zeroReader,
      blueReader: zeroReader,
      alphaReader: zeroReader,
    };
    this.#getPointCloudFieldReaders(readers, pointCloud, settings);
    const pointCount = Math.trunc(pointCloud.data.length / getStride(pointCloud));
    const itemCapacity =
      pointCount > capacity ? Math.max(pointCount, Math.ceil(capacity * 1.5)) : capacity;
    const positions = new Float32Array(deriveCoordinates ? itemCapacity * 3 : 0);
    onAllocated?.([pointCloud.data, positions]);
    const colors = new Uint8Array(itemCapacity * 4);
    onAllocated?.([pointCloud.data, positions, colors]);
    const stixelPositions = new Float32Array(
      settings.stixelsEnabled && deriveCoordinates ? itemCapacity * 6 : 0,
    );
    onAllocated?.([pointCloud.data, positions, colors, stixelPositions]);
    const stixelColors = new Uint8Array(settings.stixelsEnabled ? itemCapacity * 8 : 0);
    onAllocated?.([pointCloud.data, positions, colors, stixelPositions, stixelColors]);
    this.#updatePointCloudBuffers(
      pointCloud,
      readers,
      pointCount,
      settings,
      new THREE.BufferAttribute(positions, 3),
      new THREE.BufferAttribute(colors, 4, true),
      new THREE.BufferAttribute(stixelPositions, 3),
      new THREE.BufferAttribute(stixelColors, 4, true),
      deriveCoordinates,
    );
    return {
      pointCloud,
      pointCount,
      coordinatesPrepared: deriveCoordinates,
      positions,
      colors,
      stixelPositions,
      stixelColors,
      bounds: this.bounds,
      problems: this.problems,
      settings,
    };
  }
  public bounds: PreparedPointCloud["bounds"];

  public validate(cloud: PointCloud | PointCloud2, settings: LayerSettingsPointClouds): void {
    this.#validatePointCloud(cloud);
    const readers: PointCloudFieldReaders = {
      xReader: zeroReader,
      yReader: zeroReader,
      zReader: zeroReader,
      packedColorReader: zeroReader,
      redReader: zeroReader,
      greenReader: zeroReader,
      blueReader: zeroReader,
      alphaReader: zeroReader,
    };
    this.#getPointCloudFieldReaders(readers, cloud, settings);
  }

  public fill(
    cloud: PointCloud | PointCloud2,
    settings: LayerSettingsPointClouds,
    position: THREE.BufferAttribute,
    color: THREE.BufferAttribute,
    stixelPosition: THREE.BufferAttribute,
    stixelColor: THREE.BufferAttribute,
  ): void {
    this.#validatePointCloud(cloud);
    const readers: PointCloudFieldReaders = {
      xReader: zeroReader,
      yReader: zeroReader,
      zReader: zeroReader,
      packedColorReader: zeroReader,
      redReader: zeroReader,
      greenReader: zeroReader,
      blueReader: zeroReader,
      alphaReader: zeroReader,
    };
    this.#getPointCloudFieldReaders(readers, cloud, settings);
    this.#updatePointCloudBuffers(
      cloud,
      readers,
      Math.trunc(cloud.data.length / getStride(cloud)),
      settings,
      position,
      color,
      stixelPosition,
      stixelColor,
    );
  }
  #validatePointCloud(pointCloud: PointCloud | PointCloud2): boolean {
    const maybeRos = pointCloud as Partial<PointCloud2>;
    return maybeRos.header
      ? this.#validateRosPointCloud(pointCloud as PointCloud2)
      : this.#validateFoxglovePointCloud(pointCloud as PointCloud);
  }

  #validateFoxglovePointCloud(pointCloud: PointCloud): boolean {
    const data = pointCloud.data;

    if (data.length % pointCloud.point_stride !== 0) {
      const message = `PointCloud data length ${data.length} is not a multiple of point_stride ${pointCloud.point_stride}`;
      this.#invalidError(message);
      return false;
    }

    if (pointCloud.fields.length === 0) {
      const message = `PointCloud has no fields`;
      this.#invalidError(message);
      return false;
    }

    return true;
  }

  #validateRosPointCloud(pointCloud: PointCloud2): boolean {
    const data = pointCloud.data;

    if (pointCloud.is_bigendian) {
      const message = `PointCloud2 is_bigendian=true is not supported`;
      this.#invalidError(message);
      return false;
    }

    if (data.length % pointCloud.point_step !== 0) {
      const message = `PointCloud2 data length ${data.length} is not a multiple of point_step ${pointCloud.point_step}`;
      this.#invalidError(message);
      return false;
    }

    if (pointCloud.fields.length === 0) {
      const message = `PointCloud2 has no fields`;
      this.#invalidError(message);
      return false;
    }

    if (data.length < pointCloud.height * pointCloud.row_step) {
      const message = `PointCloud2 data length ${data.length} is less than height ${pointCloud.height} * row_step ${pointCloud.row_step}`;
      this.problems.push(message);
      // Allow this error for now since we currently ignore row_step
    }

    if (pointCloud.width * pointCloud.point_step > pointCloud.row_step) {
      const message = `PointCloud2 width ${pointCloud.width} * point_step ${pointCloud.point_step} is greater than row_step ${pointCloud.row_step}`;
      this.problems.push(message);
      // Allow this error for now since we currently ignore row_step
    }

    return true;
  }

  #getPointCloudFieldReaders(
    output: PointCloudFieldReaders,
    pointCloud: PointCloud | PointCloud2,
    settings: LayerSettingsPointClouds,
  ): boolean {
    let xReader: FieldReader | undefined;
    let yReader: FieldReader | undefined;
    let zReader: FieldReader | undefined;
    let packedColorReader: FieldReader | undefined;
    let redReader: FieldReader | undefined;
    let greenReader: FieldReader | undefined;
    let blueReader: FieldReader | undefined;
    let alphaReader: FieldReader | undefined;

    const stride = getStride(pointCloud);

    // Determine the minimum bytes needed per point based on offset/size of each
    // field, so we can ensure point_step is >= this value
    let minBytesPerPoint = 0;

    for (const field of pointCloud.fields) {
      // Skip this field, we don't support counts other than 1
      if (!isSupportedField(field)) {
        continue;
      }
      const numericType = (field as Partial<PackedElementField>).type;
      const type =
        numericType != undefined
          ? numericTypeToPointFieldType(numericType)
          : (field as PointField).datatype;

      if (field.offset < 0) {
        const message = `PointCloud field "${field.name}" has invalid offset ${field.offset}. Must be >= 0`;
        this.#invalidError(message);
        return false;
      }

      if (field.name === "x") {
        xReader = getReader(field, stride);
        if (!xReader) {
          const typeName = pointFieldTypeName(type);
          const message = `PointCloud field "x" is invalid. type=${typeName}, offset=${field.offset}, stride=${stride}`;
          this.#invalidError(message);
          return false;
        }
      } else if (field.name === "y") {
        yReader = getReader(field, stride);
        if (!yReader) {
          const typeName = pointFieldTypeName(type);
          const message = `PointCloud field "y" is invalid. type=${typeName}, offset=${field.offset}, stride=${stride}`;
          this.#invalidError(message);
          return false;
        }
      } else if (field.name === "z") {
        zReader = getReader(field, stride);
        if (!zReader) {
          const typeName = pointFieldTypeName(type);
          const message = `PointCloud field "z" is invalid. type=${typeName}, offset=${field.offset}, stride=${stride}`;
          this.#invalidError(message);
          return false;
        }
      } else if (field.name === "red") {
        redReader = getReader(field, stride, /*normalize*/ true);
      } else if (field.name === "green") {
        greenReader = getReader(field, stride, /*normalize*/ true);
      } else if (field.name === "blue") {
        blueReader = getReader(field, stride, /*normalize*/ true);
      } else if (field.name === "alpha") {
        alphaReader = getReader(field, stride, /*normalize*/ true);
      }

      const byteWidth = pointFieldWidth(type);
      minBytesPerPoint = Math.max(minBytesPerPoint, field.offset + byteWidth);

      if (field.name === settings.colorField) {
        // If the selected color mode is rgb/rgba and the field only has one channel with at least a
        // four byte width, force the color data to be interpreted as four individual bytes. This
        // overcomes a common problem where the color field data type is set to float32 or something
        // other than uint32
        const forceType =
          (settings.colorMode === "rgb" || settings.colorMode === "rgba") && byteWidth >= 4
            ? numericType != undefined
              ? NumericType.UINT32
              : PointFieldType.UINT32
            : undefined;
        packedColorReader = getReader(field, stride, /*normalize*/ false, forceType);
        if (!packedColorReader) {
          const typeName = pointFieldTypeName(type);
          const message = `PointCloud field "${field.name}" is invalid. type=${typeName}, offset=${field.offset}, stride=${stride}`;
          this.#invalidError(message);
          return false;
        }
      }
    }

    if (settings.colorFieldComputed === "distance") {
      packedColorReader = (view: DataView, pointOffset: number) => {
        return Math.hypot(
          xReader?.(view, pointOffset) ?? 0,
          yReader?.(view, pointOffset) ?? 0,
          zReader?.(view, pointOffset) ?? 0,
        );
      };
    }
    if (minBytesPerPoint > stride) {
      const message = `PointCloud stride ${stride} is less than minimum bytes per point ${minBytesPerPoint}`;
      this.#invalidError(message);
      return false;
    }

    const positionReaderCount = (xReader ? 1 : 0) + (yReader ? 1 : 0) + (zReader ? 1 : 0);
    if (positionReaderCount < 2) {
      const message = `PointCloud must contain at least two of x/y/z fields`;
      this.#invalidError(message);
      return false;
    }

    output.xReader = xReader ?? zeroReader;
    output.yReader = yReader ?? zeroReader;
    output.zReader = zReader ?? zeroReader;
    output.packedColorReader = packedColorReader ?? xReader ?? yReader ?? zReader ?? zeroReader;
    output.redReader = redReader ?? zeroReader;
    output.greenReader = greenReader ?? zeroReader;
    output.blueReader = blueReader ?? zeroReader;
    output.alphaReader = alphaReader ?? zeroReader;
    return true;
  }

  #minMaxColorValues(
    output: THREE.Vector2Tuple,
    colorReader: FieldReader,
    view: DataView,
    pointCount: number,
    pointStep: number,
    settings: LayerSettingsPointClouds,
  ): void {
    let minColorValue = settings.minValue ?? Number.POSITIVE_INFINITY;
    let maxColorValue = settings.maxValue ?? Number.NEGATIVE_INFINITY;
    if (
      NEEDS_MIN_MAX.includes(settings.colorMode) &&
      (settings.minValue == undefined || settings.maxValue == undefined)
    ) {
      for (let i = 0; i < pointCount; i++) {
        const pointOffset = i * pointStep;
        const colorValue = colorReader(view, pointOffset);
        minColorValue = Math.min(minColorValue, colorValue);
        maxColorValue = Math.max(maxColorValue, colorValue);
      }
      minColorValue = settings.minValue ?? minColorValue;
      maxColorValue = settings.maxValue ?? maxColorValue;
    }

    output[0] = minColorValue;
    output[1] = maxColorValue;
  }

  #updatePointCloudBuffers(
    pointCloud: PointCloud | PointCloud2,
    readers: PointCloudFieldReaders,
    pointCount: number,
    settings: LayerSettingsPointClouds,
    positionAttribute: THREE.BufferAttribute,
    colorAttribute: THREE.BufferAttribute,
    stixelPositionAttribute: THREE.BufferAttribute,
    stixelColorAttribute: THREE.BufferAttribute,
    deriveCoordinates = true,
  ): void {
    const data = pointCloud.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pointStep = getStride(pointCloud);
    const {
      xReader,
      yReader,
      zReader,
      packedColorReader,
      redReader,
      greenReader,
      blueReader,
      alphaReader,
    } = readers;

    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    let reliable = true;
    // Derive bounds in the XYZ pass, using the final Float32 attribute values.
    if (deriveCoordinates)
      for (let i = 0; i < pointCount; i++) {
        const pointOffset = i * pointStep;
        const x = xReader(view, pointOffset);
        const y = yReader(view, pointOffset);
        const z = zReader(view, pointOffset);
        positionAttribute.setXYZ(i, x, y, z);
        const fx = positionAttribute.getX(i),
          fy = positionAttribute.getY(i),
          fz = positionAttribute.getZ(i);
        reliable &&= Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz);
        minX = Math.min(minX, fx);
        minY = Math.min(minY, fy);
        minZ = Math.min(minZ, fz);
        maxX = Math.max(maxX, fx);
        maxY = Math.max(maxY, fy);
        maxZ = Math.max(maxZ, fz);
        if (settings.stixelsEnabled) {
          stixelPositionAttribute.setXYZ(i * 2, x, y, z);
          stixelPositionAttribute.setXYZ(i * 2 + 1, x, y, 0);
        }
      }

    this.bounds =
      deriveCoordinates && reliable && pointCount > 0
        ? {
            min: [minX, minY, settings.stixelsEnabled ? Math.min(minZ, 0) : minZ],
            max: [maxX, maxY, settings.stixelsEnabled ? Math.max(maxZ, 0) : maxZ],
          }
        : undefined;

    // Update color attribute
    if (settings.colorMode === "rgba-fields") {
      for (let i = 0; i < pointCount; i++) {
        const pointOffset = i * pointStep;
        const r = redReader(view, pointOffset);
        const g = greenReader(view, pointOffset);
        const b = blueReader(view, pointOffset);
        const a = alphaReader(view, pointOffset);
        colorAttribute.setXYZW(i, r, g, b, a);
        if (settings.stixelsEnabled) {
          stixelColorAttribute.setXYZW(i * 2, r, g, b, a);
          stixelColorAttribute.setXYZW(i * 2 + 1, r, g, b, a);
        }
      }
    } else {
      // Iterate the point cloud data to determine min/max color values (if needed)
      this.#minMaxColorValues(
        tempMinMaxColor,
        packedColorReader,
        view,
        pointCount,
        pointStep,
        settings,
      );
      const [minColorValue, maxColorValue] = tempMinMaxColor;

      // Build a method to convert raw color field values to RGBA
      const colorConverter = getColorConverter(
        settings as typeof settings & { colorMode: typeof settings.colorMode },
        minColorValue,
        maxColorValue,
      );

      const isFlatColor = settings.colorMode === "flat";
      if (isFlatColor && pointCount > 0) {
        colorConverter(tempColor, 0);
      }
      for (let i = 0; i < pointCount; i++) {
        if (!isFlatColor) {
          const pointOffset = i * pointStep;
          const colorValue = packedColorReader(view, pointOffset);
          colorConverter(tempColor, colorValue);
        }
        colorAttribute.setXYZW(i, tempColor.r, tempColor.g, tempColor.b, tempColor.a);
        if (settings.stixelsEnabled) {
          stixelColorAttribute.setXYZW(i * 2, tempColor.r, tempColor.g, tempColor.b, tempColor.a);
          stixelColorAttribute.setXYZW(
            i * 2 + 1,
            tempColor.r,
            tempColor.g,
            tempColor.b,
            tempColor.a,
          );
        }
      }
    }

    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    stixelPositionAttribute.needsUpdate = true;
    stixelColorAttribute.needsUpdate = true;
  }
}

function pointFieldTypeName(type: PointFieldType): string {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return PointFieldType[type] ?? `${type}`;
}

function pointFieldWidth(type: PointFieldType): number {
  switch (type) {
    case PointFieldType.INT8:
    case PointFieldType.UINT8:
      return 1;
    case PointFieldType.INT16:
    case PointFieldType.UINT16:
      return 2;
    case PointFieldType.INT32:
    case PointFieldType.UINT32:
    case PointFieldType.FLOAT32:
      return 4;
    case PointFieldType.FLOAT64:
      return 8;
    default:
      return 0;
  }
}

function zeroReader(): number {
  return 0;
}

function normalizePointField(field: PartialMessage<PointField> | undefined): PointField {
  if (!field) {
    return { name: "", offset: 0, datatype: PointFieldType.UNKNOWN, count: 0 };
  }
  return {
    name: field.name ?? "",
    offset: field.offset ?? 0,
    datatype: field.datatype ?? PointFieldType.UNKNOWN,
    count: field.count ?? 0,
  };
}

function normalizePackedElementField(
  field: PartialMessage<PackedElementField> | undefined,
): PackedElementField {
  return {
    name: field?.name ?? "",
    offset: field?.offset ?? 0,
    type: field?.type ?? 0,
  };
}

export function normalizePointCloud(message: PartialMessage<PointCloud>): PointCloud {
  return {
    timestamp: normalizeTime(message.timestamp),
    frame_id: message.frame_id ?? "",
    pose: normalizePose(message.pose),
    point_stride: message.point_stride ?? 0,
    fields: message.fields?.map(normalizePackedElementField) ?? [],
    data: normalizeByteArray(message.data),
  };
}

export function normalizePointCloud2(message: PartialMessage<PointCloud2>): PointCloud2 {
  return {
    header: normalizeHeader(message.header),
    height: message.height ?? 0,
    width: message.width ?? 0,
    fields: message.fields?.map(normalizePointField) ?? [],
    is_bigendian: message.is_bigendian ?? false,
    point_step: message.point_step ?? 0,
    row_step: message.row_step ?? 0,
    data: normalizeByteArray(message.data),
    is_dense: message.is_dense ?? false,
  };
}

export function getTimestamp(pointCloud: PointCloud | PointCloud2): Time {
  const maybeRos = pointCloud as Partial<PointCloud2>;
  return maybeRos.header ? maybeRos.header.stamp : (pointCloud as PointCloud).timestamp;
}

export function getFrameId(pointCloud: PointCloud | PointCloud2): string {
  const maybeRos = pointCloud as Partial<PointCloud2>;
  return maybeRos.header ? maybeRos.header.frame_id : (pointCloud as PointCloud).frame_id;
}

export function getStride(pointCloud: PointCloud | PointCloud2): number {
  const maybeRos = pointCloud as Partial<PointCloud2>;
  return maybeRos.point_step ?? (pointCloud as PointCloud).point_stride;
}

export function getPose(pointCloud: PointCloud | PointCloud2): Pose {
  const maybeFoxglove = pointCloud as Partial<PointCloud>;
  return maybeFoxglove.pose ?? makePose();
}
