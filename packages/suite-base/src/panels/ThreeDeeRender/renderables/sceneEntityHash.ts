// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import {
  ArrowPrimitive,
  Color,
  CubePrimitive,
  CylinderPrimitive,
  LinePrimitive,
  ModelPrimitive,
  Pose,
  SceneEntity,
  SpherePrimitive,
  TextPrimitive,
  TriangleListPrimitive,
  Vector3,
} from "@foxglove/schemas";

/**
 * Content hash over the geometry-affecting fields of a normalized SceneEntity:
 * every primitive array, and per primitive its pose, sizes, thickness/scale,
 * points/vertices, colors, indices, text and model sources — everything that
 * feeds GPU buffers or scene placement in the primitive renderables.
 *
 * Entity-level `timestamp`, `frame_id`, `frame_locked`, `lifetime` and
 * `metadata` are deliberately excluded: they never reach GPU buffers, and
 * TopicEntities refreshes `userData.entity` on the skip path so pose lookup
 * and details() still see their latest values. This keeps the hash stable
 * across the common case of a layer republishing identical geometry with a
 * fresh timestamp every message.
 *
 * The hash is a cyrb53-style dual 32-bit accumulator (53-bit result) walked
 * over IEEE-754 bit patterns without building an intermediate string, so it
 * allocates nothing per message. A false match only delays one visual update
 * and self-heals on the next content change. Scratch state is module-level;
 * hashSceneEntityContent is not reentrant.
 */
const scratchF64 = new Float64Array(1);
const scratchU32 = new Uint32Array(scratchF64.buffer);

let h1 = 0;
let h2 = 0;

function mixWord(word: number): void {
  h1 = Math.imul(h1 ^ word, 2654435761);
  h2 = Math.imul(h2 ^ word, 1597334677);
}

// Distinct salts so false/true can never alias a length or small enum value
const MIX_FALSE = 0x165667b1;
const MIX_TRUE = 0x27d4eb2f;

function mixNumber(value: number): void {
  scratchF64[0] = value;
  mixWord(scratchU32[0]!);
  mixWord(scratchU32[1]!);
}

function mixString(value: string): void {
  mixNumber(value.length);
  for (let i = 0; i < value.length; i++) {
    mixWord(value.charCodeAt(i));
  }
}

function mixBytes(data: Uint8Array): void {
  mixNumber(data.length);
  for (const byte of data) {
    mixWord(byte);
  }
}

function hashPose(pose: Pose): void {
  mixNumber(pose.position.x);
  mixNumber(pose.position.y);
  mixNumber(pose.position.z);
  mixNumber(pose.orientation.x);
  mixNumber(pose.orientation.y);
  mixNumber(pose.orientation.z);
  mixNumber(pose.orientation.w);
}

function hashVector3(vector: Vector3): void {
  mixNumber(vector.x);
  mixNumber(vector.y);
  mixNumber(vector.z);
}

function hashColor(color: Color): void {
  mixNumber(color.r);
  mixNumber(color.g);
  mixNumber(color.b);
  mixNumber(color.a);
}

function hashPoints(points: Vector3[]): void {
  mixNumber(points.length);
  for (const point of points) {
    hashVector3(point);
  }
}

function hashColors(colors: Color[]): void {
  mixNumber(colors.length);
  for (const color of colors) {
    hashColor(color);
  }
}

function hashIndices(indices: number[]): void {
  mixNumber(indices.length);
  for (const index of indices) {
    mixNumber(index);
  }
}

function hashArrows(arrows: ArrowPrimitive[]): void {
  mixWord(0xa0);
  mixNumber(arrows.length);
  for (const arrow of arrows) {
    hashPose(arrow.pose);
    mixNumber(arrow.shaft_length);
    mixNumber(arrow.shaft_diameter);
    mixNumber(arrow.head_length);
    mixNumber(arrow.head_diameter);
    hashColor(arrow.color);
  }
}

function hashCubes(cubes: CubePrimitive[]): void {
  mixWord(0xc0);
  mixNumber(cubes.length);
  for (const cube of cubes) {
    hashPose(cube.pose);
    hashVector3(cube.size);
    hashColor(cube.color);
  }
}

function hashSpheres(spheres: SpherePrimitive[]): void {
  mixWord(0x50);
  mixNumber(spheres.length);
  for (const sphere of spheres) {
    hashPose(sphere.pose);
    hashVector3(sphere.size);
    hashColor(sphere.color);
  }
}

function hashCylinders(cylinders: CylinderPrimitive[]): void {
  mixWord(0xc1);
  mixNumber(cylinders.length);
  for (const cylinder of cylinders) {
    hashPose(cylinder.pose);
    hashVector3(cylinder.size);
    mixNumber(cylinder.bottom_scale);
    mixNumber(cylinder.top_scale);
    hashColor(cylinder.color);
  }
}

function hashLines(lines: LinePrimitive[]): void {
  mixWord(0x10);
  mixNumber(lines.length);
  for (const line of lines) {
    mixWord(line.type);
    hashPose(line.pose);
    mixNumber(line.thickness);
    mixWord(line.scale_invariant ? MIX_TRUE : MIX_FALSE);
    hashPoints(line.points);
    hashColor(line.color);
    hashColors(line.colors);
    hashIndices(line.indices);
  }
}

function hashTriangles(triangles: TriangleListPrimitive[]): void {
  mixWord(0x70);
  mixNumber(triangles.length);
  for (const triangle of triangles) {
    hashPose(triangle.pose);
    hashPoints(triangle.points);
    hashColor(triangle.color);
    hashColors(triangle.colors);
    hashIndices(triangle.indices);
  }
}

function hashTexts(texts: TextPrimitive[]): void {
  mixWord(0x7e);
  mixNumber(texts.length);
  for (const text of texts) {
    hashPose(text.pose);
    mixWord(text.billboard ? MIX_TRUE : MIX_FALSE);
    mixNumber(text.font_size);
    mixWord(text.scale_invariant ? MIX_TRUE : MIX_FALSE);
    hashColor(text.color);
    mixString(text.text);
  }
}

function hashModels(models: ModelPrimitive[]): void {
  mixWord(0xb0);
  mixNumber(models.length);
  for (const model of models) {
    hashPose(model.pose);
    hashVector3(model.scale);
    hashColor(model.color);
    mixWord(model.override_color ? MIX_TRUE : MIX_FALSE);
    mixString(model.url);
    mixString(model.media_type);
    mixBytes(model.data);
  }
}

export function hashSceneEntityContent(entity: SceneEntity): number {
  h1 = 0xdeadbeef;
  h2 = 0x41c6ce57;

  hashArrows(entity.arrows);
  hashCubes(entity.cubes);
  hashSpheres(entity.spheres);
  hashCylinders(entity.cylinders);
  hashLines(entity.lines);
  hashTriangles(entity.triangles);
  hashTexts(entity.texts);
  hashModels(entity.models);

  // cyrb53 finalization
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
