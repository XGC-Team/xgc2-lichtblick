// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

/** CPU storage shared by the depth, color and picking passes of one polyline. */
export class LineStripBuffers {
  public positions = new Float32Array();
  public colors = new Uint8Array();
  public distances = new Float32Array();
  public segmentCount = 0;
  public readonly min = { x: 0, y: 0, z: 0 };
  public readonly max = { x: 0, y: 0, z: 0 };
  public readonly center = { x: 0, y: 0, z: 0 };
  public radius = 0;

  /** Update every supplied point, returning whether GPU attributes must be rebound. */
  public update(points: readonly Readonly<{ x: number; y: number; z: number }>[]): boolean {
    const segmentCount = (this.segmentCount = Math.max(0, points.length - 1));
    const capacity = this.positions.length / 6;
    const grew = segmentCount > capacity;
    if (grew) {
      // Amortize growing histories; capacity is storage, never a sampling limit.
      const nextCapacity = Math.max(segmentCount, capacity * 2, 1);
      this.positions = new Float32Array(nextCapacity * 6);
      this.colors = new Uint8Array(nextCapacity * 8);
      this.distances = new Float32Array(nextCapacity * 2);
    }

    const first = points[0];
    let x = Math.fround(first?.x ?? 0);
    let y = Math.fround(first?.y ?? 0);
    let z = Math.fround(first?.z ?? 0);
    let minX = x;
    let minY = y;
    let minZ = z;
    let maxX = x;
    let maxY = y;
    let maxZ = z;
    const { positions, distances } = this;
    for (let i = 0; i < segmentCount; i++) {
      const next = points[i + 1]!;
      const nx = Math.fround(next.x);
      const ny = Math.fround(next.y);
      const nz = Math.fround(next.z);
      const offset = i * 6;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      positions[offset + 3] = nx;
      positions[offset + 4] = ny;
      positions[offset + 5] = nz;
      const dx = nx - x;
      const dy = ny - y;
      const dz = nz - z;
      // Match LineSegments2's Float32 positions and cumulative distance rounding.
      distances[i * 2] = i === 0 ? 0 : distances[i * 2 - 1]!;
      distances[i * 2 + 1] = distances[i * 2]! + Math.sqrt(dx * dx + dy * dy + dz * dz);
      minX = Math.min(minX, nx);
      minY = Math.min(minY, ny);
      minZ = Math.min(minZ, nz);
      maxX = Math.max(maxX, nx);
      maxY = Math.max(maxY, ny);
      maxZ = Math.max(maxZ, nz);
      x = nx;
      y = ny;
      z = nz;
    }

    this.min.x = minX;
    this.min.y = minY;
    this.min.z = minZ;
    this.max.x = maxX;
    this.max.y = maxY;
    this.max.z = maxZ;
    const cx = (this.center.x = (minX + maxX) / 2);
    const cy = (this.center.y = (minY + maxY) / 2);
    const cz = (this.center.z = (minZ + maxZ) / 2);
    let radiusSquared = 0;
    // Only active segments participate: an old tail must not enlarge the bounds.
    for (let i = 0; i < segmentCount * 6; i += 3) {
      const dx = positions[i]! - cx;
      const dy = positions[i + 1]! - cy;
      const dz = positions[i + 2]! - cz;
      radiusSquared = Math.max(radiusSquared, dx * dx + dy * dy + dz * dz);
    }
    this.radius = Math.sqrt(radiusSquared);
    return grew;
  }
}
