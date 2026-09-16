// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { ObjectPool } from "@lichtblick/den/collection";

import { makePose } from "./transforms";
import { Transform } from "./transforms/Transform";
import { TransformTree } from "./transforms/TransformTree";
import { updatePose } from "./updatePose";

function translation(x: number, y: number, z: number): Transform {
  return new Transform([x, y, z], [0, 0, 0, 1]);
}

/** world <- odom(1,0,0) <- base_link(0,2,0), all stamped at 0n */
function makeTree(): TransformTree {
  const tree = new TransformTree(new ObjectPool(Transform.Empty));
  tree.addTransform("odom", "world", 0n, translation(1, 0, 0));
  tree.addTransform("base_link", "odom", 0n, translation(0, 2, 0));
  return tree;
}

function makeRenderable(frameId: string = "base_link"): THREE.Object3D {
  const renderable = new THREE.Object3D();
  renderable.name = `renderable-${frameId}`;
  renderable.userData.frameId = frameId;
  renderable.userData.pose = makePose();
  return renderable;
}

describe("updatePose", () => {
  it("applies the composed transform to the renderable", () => {
    const tree = makeTree();
    const renderable = makeRenderable();
    const applied = updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    expect(applied).toBe(true);
    expect(renderable.visible).toBe(true);
    expect(renderable.position.x).toBeCloseTo(1);
    expect(renderable.position.y).toBeCloseTo(2);
    expect(renderable.position.z).toBeCloseTo(0);
  });

  it("memoizes the pose while frames, times, and tree are unchanged", () => {
    const tree = makeTree();
    const applySpy = jest.spyOn(tree, "apply");
    const renderable = makeRenderable();

    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  it("reuses the pose for any query time that clamps to the newest transform", () => {
    const tree = makeTree();
    const applySpy = jest.spyOn(tree, "apply");
    const renderable = makeRenderable();

    // All transforms are stamped at 0n, so later query times clamp and the
    // result is time-independent.
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    updatePose(renderable, tree, "world", "world", "base_link", 10n, 10n);
    updatePose(renderable, tree, "world", "world", "base_link", 1000n, 999n);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  it("recomputes when a transform on the frame path changes", () => {
    const tree = makeTree();
    const applySpy = jest.spyOn(tree, "apply");
    const renderable = makeRenderable();

    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    tree.addTransform("base_link", "odom", 10n, translation(0, 7, 0));
    updatePose(renderable, tree, "world", "world", "base_link", 20n, 20n);

    expect(applySpy).toHaveBeenCalledTimes(2);
    expect(renderable.position.y).toBeCloseTo(7);
  });

  it("does not recompute when a transform off the frame path changes", () => {
    const tree = makeTree();
    const renderable = makeRenderable();
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);

    const applySpy = jest.spyOn(tree, "apply");
    tree.addTransform("unrelated_sensor", "world", 6n, translation(9, 9, 9));
    updatePose(renderable, tree, "world", "world", "base_link", 20n, 20n);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("recomputes when the local pose values change", () => {
    const tree = makeTree();
    const renderable = makeRenderable();
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);

    const applySpy = jest.spyOn(tree, "apply");
    // In-place mutation, as message handlers do when reusing pose objects
    renderable.userData.pose.position.z = 3;
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(renderable.position.z).toBeCloseTo(3);
  });

  it("recomputes when the render frame changes", () => {
    const tree = makeTree();
    const renderable = makeRenderable();
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);

    const applySpy = jest.spyOn(tree, "apply");
    updatePose(renderable, tree, "odom", "world", "base_link", 5n, 5n);
    expect(applySpy).toHaveBeenCalledTimes(1);
    // base_link expressed in odom loses the world<-odom translation
    expect(renderable.position.x).toBeCloseTo(0);
    expect(renderable.position.y).toBeCloseTo(2);
  });

  it("keeps interpolating at the source time while the destination time clamps", () => {
    const tree = new TransformTree(new ObjectPool(Transform.Empty));
    tree.addTransform("odom", "world", 0n, translation(1, 0, 0));
    tree.addTransform("base_link", "odom", 0n, translation(0, 0, 0));
    tree.addTransform("base_link", "odom", 100n, translation(0, 10, 0));
    const applySpy = jest.spyOn(tree, "apply");
    const renderable = makeRenderable();

    // srcTime sits between the two base_link transforms (time-dependent),
    // dstTime clamps to the newest odom transform (time-independent).
    updatePose(renderable, tree, "odom", "world", "base_link", 1000n, 50n);
    expect(renderable.position.y).toBeCloseTo(5);
    // A new destination time that still clamps must not recompute...
    updatePose(renderable, tree, "odom", "world", "base_link", 2000n, 50n);
    expect(applySpy).toHaveBeenCalledTimes(1);
    // ...but a new source time must.
    updatePose(renderable, tree, "odom", "world", "base_link", 2000n, 75n);
    expect(applySpy).toHaveBeenCalledTimes(2);
    expect(renderable.position.y).toBeCloseTo(7.5);
  });

  it("memoizes missing-frame failures and recovers when the frame appears", () => {
    const tree = makeTree();
    const applySpy = jest.spyOn(tree, "apply");
    const renderable = makeRenderable("late_frame");

    expect(updatePose(renderable, tree, "world", "world", "late_frame", 5n, 5n)).toBe(false);
    expect(renderable.visible).toBe(false);
    expect(updatePose(renderable, tree, "world", "world", "late_frame", 6n, 6n)).toBe(false);
    const callsWhileMissing = applySpy.mock.calls.length;

    tree.addTransform("late_frame", "world", 10n, translation(4, 0, 0));
    expect(updatePose(renderable, tree, "world", "world", "late_frame", 20n, 20n)).toBe(true);
    expect(renderable.visible).toBe(true);
    expect(renderable.position.x).toBeCloseTo(4);
    expect(applySpy.mock.calls.length).toBeGreaterThan(callsWhileMissing);
  });

  it("invalidates when a frame offset is applied to the path", () => {
    const tree = makeTree();
    const renderable = makeRenderable();
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);

    const applySpy = jest.spyOn(tree, "apply");
    const odom = tree.frame("odom")!;
    odom.offsetPosition = [10, 0, 0];
    updatePose(renderable, tree, "world", "world", "base_link", 5n, 5n);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(renderable.position.x).toBeCloseTo(11);
  });
});
