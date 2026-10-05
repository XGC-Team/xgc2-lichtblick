// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

type TypedArrayConstructor<T extends THREE.TypedArray> = new (length: number) => T;

export class DynamicBufferGeometry extends THREE.BufferGeometry {
  public override attributes: { [name: string]: THREE.BufferAttribute } = {};

  #attributeConstructors = new Map<string, TypedArrayConstructor<THREE.TypedArray>>();
  #usage: THREE.Usage;
  #itemCapacity = 0;
  #preparedArraysImmutable = false;

  public constructor(usage: THREE.Usage = THREE.DynamicDrawUsage) {
    super();
    this.#usage = usage;
  }

  public setUsage(usage: THREE.Usage): void {
    this.#usage = usage;
    for (const attribute of Object.values(this.attributes)) {
      attribute.setUsage(usage);
    }
  }

  public createAttribute<T extends THREE.TypedArray, C extends TypedArrayConstructor<T>>(
    name: string,
    arrayConstructor: C,
    itemSize: number,
    // eslint-disable-next-line @lichtblick/no-boolean-parameters
    normalized?: boolean,
  ): THREE.BufferGeometry {
    const data = new arrayConstructor(this.#itemCapacity * itemSize);
    const attribute = new THREE.BufferAttribute(data, itemSize, normalized);
    attribute.setUsage(this.#usage);
    this.#attributeConstructors.set(name, arrayConstructor);
    return this.setAttribute(name, attribute);
  }

  public get itemCapacity(): number {
    return this.#itemCapacity;
  }
  public get capacityBytes(): number {
    return Object.values(this.attributes).reduce((sum, a) => sum + a.array.byteLength, 0);
  }

  /** Adopt one immutable prepared sample; never mutate arrays shared by another consumer. */
  public adopt(itemCount: number, arrays: Readonly<Record<string, THREE.TypedArray>>): number {
    if (itemCount === 0) {
      this.setDrawRange(0, 0);
      return 0;
    }
    let capacity: number | undefined;
    for (const [name, attribute] of Object.entries(this.attributes)) {
      const array = arrays[name];
      if (
        array == undefined ||
        array.constructor !== attribute.array.constructor ||
        array.length % attribute.itemSize !== 0
      )
        throw new Error(`Prepared attribute ${name} has incompatible dtype or itemSize`);
      const n = array.length / attribute.itemSize;
      if (n < itemCount || (capacity != undefined && capacity !== n))
        throw new Error("Prepared attribute capacities disagree");
      capacity = n;
    }
    const nextCapacity = capacity ?? 0;
    const grow = nextCapacity !== this.#itemCapacity;
    const oldBytes = grow ? this.capacityBytes : 0;
    const replacements = new Map<string, THREE.BufferAttribute>();
    if (grow)
      for (const [name, attribute] of Object.entries(this.attributes)) {
        const next = new THREE.BufferAttribute(
          arrays[name]!,
          attribute.itemSize,
          attribute.normalized,
        );
        next.setUsage(this.#usage);
        replacements.set(name, next);
      }
    // Disposal must still expose the old attached attributes to Three's GPU buffer owner.
    if (grow) this.dispose();
    for (const [name, old] of Object.entries(this.attributes)) {
      const attribute = grow ? replacements.get(name)! : old;
      if (grow) this.setAttribute(name, attribute);
      else {
        attribute.array = arrays[name]!;
        // Three 0.156 does not update count after assigning array.
        (attribute as { count: number }).count = nextCapacity;
      }
      attribute.updateRange.offset = 0;
      attribute.updateRange.count = itemCount * attribute.itemSize;
      attribute.needsUpdate = true;
    }
    this.#preparedArraysImmutable = true;
    this.#itemCapacity = nextCapacity;
    this.setDrawRange(0, itemCount);
    return oldBytes + (grow ? this.capacityBytes : 0);
  }

  public adoptColors(itemCount: number, color: THREE.TypedArray): void {
    if (itemCount === 0) {
      this.setDrawRange(0, 0);
      return;
    }
    const attribute = this.attributes.color!;
    if (
      color.constructor !== attribute.array.constructor ||
      color.length !== this.#itemCapacity * attribute.itemSize
    )
      throw new Error("Prepared color capacity/dtype changed without coordinate preparation");
    attribute.array = color;
    attribute.updateRange.offset = 0;
    attribute.updateRange.count = itemCount * attribute.itemSize;
    attribute.needsUpdate = true;
    this.#preparedArraysImmutable = true;
    this.setDrawRange(0, itemCount);
  }

  public resize(itemCount: number): void {
    this.setDrawRange(0, itemCount);

    if (itemCount <= this.#itemCapacity) {
      if (itemCount > 0 && this.#preparedArraysImmutable) {
        // Ordered/history writers must not mutate a sample shared with another renderer.
        for (const [name, attribute] of Object.entries(this.attributes)) {
          const constructor = this.#attributeConstructors.get(name)!;
          attribute.array = new constructor(this.#itemCapacity * attribute.itemSize);
        }
        this.#preparedArraysImmutable = false;
      }
      return;
    }

    // Grow with headroom: point counts often fluctuate by a few vertices per frame.
    // Build replacements before disposing so allocation/validation failures leave the
    // currently rendered attributes intact.
    const capacity = Math.max(itemCount, Math.ceil(this.#itemCapacity * 1.5));
    const replacements = new Map<string, THREE.BufferAttribute>();
    for (const [attributeName, attribute] of Object.entries(this.attributes)) {
      const dataConstructor = this.#attributeConstructors.get(attributeName);
      if (!dataConstructor) {
        throw new Error(
          `DynamicBufferGeometry resize(${itemCount}) failed, missing data constructor for attribute "${attributeName}". Attributes must be created using createAttribute().`,
        );
      }
      const data = new dataConstructor(capacity * attribute.itemSize);
      const newAttrib = new THREE.BufferAttribute(data, attribute.itemSize, attribute.normalized);
      newAttrib.setUsage(this.#usage);
      replacements.set(attributeName, newAttrib);
    }

    // Three.js must see the OLD attributes when its dispose listener deletes GPU buffers.
    // The geometry object remains reusable; the next render uploads the replacements.
    this.dispose();
    for (const [attributeName, attribute] of replacements) {
      this.setAttribute(attributeName, attribute);
    }
    this.#preparedArraysImmutable = false;
    this.#itemCapacity = capacity;
  }
}
