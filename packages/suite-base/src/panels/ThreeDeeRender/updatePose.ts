// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { vec3 } from "gl-matrix";
import * as THREE from "three";

import { TransformTree, makePose, Pose, AnyFrameId } from "./transforms";
import { CoordinateFrame } from "./transforms/CoordinateFrame";
import { Time } from "./transforms/time";

const tempPose = makePose();

// Reused scratch buffers for offset reference collection during signature
// walks; updatePose is not reentrant.
const scratchSrcOffsets: (vec3 | undefined)[] = [];
const scratchDstOffsets: (vec3 | undefined)[] = [];
const NO_OFFSETS: readonly (vec3 | undefined)[] = [];

/**
 * Cached outcome of one updatePose() call. `srcTime`/`dstTime` are the exact
 * query times, or `undefined` when the query clamps to the newest transform on
 * every frame of the respective path, making the result independent of the
 * exact time.
 */
type PoseMemo = {
  tree: TransformTree;
  renderFrame: CoordinateFrame<AnyFrameId> | undefined;
  fixedFrame: CoordinateFrame<AnyFrameId> | undefined;
  srcFrame: CoordinateFrame<AnyFrameId> | undefined;
  renderFrameId: AnyFrameId;
  fixedFrameId: AnyFrameId;
  srcFrameId: string;
  srcTime: Time | undefined;
  dstTime: Time | undefined;
  pathVersion: number;
  /** offsetPosition/offsetEulerDegrees references of every walked frame */
  offsetRefs: readonly (vec3 | undefined)[];
  poseValues: readonly [number, number, number, number, number, number, number];
  applied: boolean;
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
};

// Renderables are owned by a single renderer and disposed with it, so a
// WeakMap keeps memo entries collectible without explicit invalidation.
const poseMemos = new WeakMap<THREE.Object3D, PoseMemo>();

type ChainSignature = {
  version: number;
  newestTime: Time | undefined;
  framesRead: number;
  /** True when the walk stopped at `stopAt`, i.e. it is an ancestor frame */
  exact: boolean;
  hasEmptyFrame: boolean;
};

/**
 * Signature of the ancestor chain `apply()` reads when transforming through
 * `frame` towards `stopAt`: the summed mutation versions plus the newest
 * transform stamp. `GetTransformMatrix` reads each frame's history up to but
 * excluding the destination frame, so the walk stops at `stopAt` when it is an
 * ancestor (exact); otherwise it walks the whole chain (conservative
 * superset). A query at or after `newestTime` clamps to the newest transform
 * on every frame of the chain, so its result no longer depends on the exact
 * query time.
 */
function chainSignature(
  frame: CoordinateFrame<AnyFrameId>,
  stopAt: CoordinateFrame<AnyFrameId> | undefined,
  offsetsOut: (vec3 | undefined)[],
): ChainSignature {
  let version = 0;
  let newestTime: Time | undefined;
  let framesRead = 0;
  let hasEmptyFrame = false;
  let current: CoordinateFrame<AnyFrameId> | undefined = frame;
  while (current) {
    if (current === stopAt) {
      return { version, newestTime, framesRead, exact: true, hasEmptyFrame };
    }
    version += current.getVersion();
    framesRead++;
    // GetTransformMatrix reads offset fields directly, so the memo must
    // observe them being replaced; references are compared later.
    offsetsOut.push(current.offsetPosition, current.offsetEulerDegrees);
    const frameNewest = current.newestTransformTime();
    if (frameNewest == undefined) {
      hasEmptyFrame = true;
    } else if (newestTime == undefined || frameNewest > newestTime) {
      newestTime = frameNewest;
    }
    current = current.parent();
  }
  return { version, newestTime, framesRead, exact: false, hasEmptyFrame };
}

/**
 * Signature of the frames `applyLocal(rootFrame, leaf)` may read. When the
 * root is not an ancestor of the leaf, applyLocal instead reads frames
 * between the root and the leaf (or up to a common ancestor); fold the root's
 * own chain in as a conservative superset and drop exactness.
 */
function pathSignature(
  leaf: CoordinateFrame<AnyFrameId>,
  rootFrame: CoordinateFrame<AnyFrameId> | undefined,
  offsetsOut: (vec3 | undefined)[],
): ChainSignature {
  const sig = chainSignature(leaf, rootFrame, offsetsOut);
  if (!sig.exact && rootFrame && rootFrame !== leaf) {
    const rootSig = chainSignature(rootFrame, undefined, offsetsOut);
    sig.version += rootSig.version;
    sig.framesRead += rootSig.framesRead;
    if (
      rootSig.newestTime != undefined &&
      (sig.newestTime == undefined || rootSig.newestTime > sig.newestTime)
    ) {
      sig.newestTime = rootSig.newestTime;
    }
    sig.hasEmptyFrame = sig.hasEmptyFrame || rootSig.hasEmptyFrame;
  }
  return sig;
}

/**
 * A path's query time is irrelevant when the path reads no frames (identity),
 * when a frame it provably reads has an empty history (apply() fails at any
 * time), or when the query clamps to the newest transform of every frame it
 * may read.
 */
function isTimeIndependent(sig: ChainSignature, time: Time): boolean {
  if (sig.framesRead === 0) {
    return true;
  }
  if (sig.hasEmptyFrame) {
    return sig.exact;
  }
  return sig.newestTime != undefined && time >= sig.newestTime;
}

function readPoseValues(
  pose: Readonly<Pose>,
): [number, number, number, number, number, number, number] {
  const p = pose.position;
  const q = pose.orientation;
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
}

function poseValuesEqual(
  a: readonly [number, number, number, number, number, number, number],
  b: readonly [number, number, number, number, number, number, number],
): boolean {
  for (let i = 0; i < 7; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function offsetRefsEqual(
  memoRefs: readonly (vec3 | undefined)[],
  srcRefs: readonly (vec3 | undefined)[],
  dstRefs: readonly (vec3 | undefined)[],
): boolean {
  if (memoRefs.length !== srcRefs.length + dstRefs.length) {
    return false;
  }
  for (let i = 0; i < srcRefs.length; i++) {
    if (memoRefs[i] !== srcRefs[i]) {
      return false;
    }
  }
  for (let i = 0; i < dstRefs.length; i++) {
    if (memoRefs[srcRefs.length + i] !== dstRefs[i]) {
      return false;
    }
  }
  return true;
}

export function updatePose(
  renderable: THREE.Object3D,
  transformTree: TransformTree,
  renderFrameId: AnyFrameId,
  fixedFrameId: AnyFrameId,
  srcFrameId: string,
  dstTime: bigint,
  srcTime: bigint,
): boolean {
  const pose = renderable.userData.pose as Readonly<Pose> | undefined;
  if (!pose) {
    throw new Error(`Missing userData.pose for ${renderable.name}`);
  }

  const renderFrame = transformTree.frame(renderFrameId);
  const fixedFrame = transformTree.frame(fixedFrameId);
  const srcFrame = transformTree.frame(srcFrameId);

  // The fallback frame shortcuts apply() without reading transform history and
  // returns the shared temp pose as-is, so results there are not a pure
  // function of the memo key. Bypass memoization when it is involved. The
  // source frame id is always a user frame id (string), so only the render
  // and fixed frames can be the fallback frame.
  const fallbackInvolved =
    renderFrame?.id === CoordinateFrame.FALLBACK_FRAME_ID ||
    fixedFrame?.id === CoordinateFrame.FALLBACK_FRAME_ID;

  if (!fallbackInvolved) {
    // Frames missing from the tree make apply() fail deterministically, which
    // is memoizable too; identity comparison against the memo covers frames
    // that are created later (tree lookups then return a different object).
    // apply() falls back to the render frame's own root when the fixed frame
    // is missing, so mirror that here.
    const rootFrame = fixedFrame ?? renderFrame?.root();
    scratchSrcOffsets.length = 0;
    scratchDstOffsets.length = 0;
    const srcSig = srcFrame ? pathSignature(srcFrame, rootFrame, scratchSrcOffsets) : undefined;
    const dstSig = renderFrame
      ? pathSignature(renderFrame, rootFrame, scratchDstOffsets)
      : undefined;
    // The source time only drives the src->root path and the destination time
    // only the root->render path, so each is evaluated independently. A
    // missing frame fails apply() regardless of the query time.
    const srcTimeIndependent = !srcFrame || isTimeIndependent(srcSig!, srcTime);
    const dstTimeIndependent = !renderFrame || isTimeIndependent(dstSig!, dstTime);
    const srcTimeKey = srcTimeIndependent ? undefined : srcTime;
    const dstTimeKey = dstTimeIndependent ? undefined : dstTime;
    const pathVersion = (srcSig?.version ?? 0) + (dstSig?.version ?? 0);
    const poseValues = readPoseValues(pose);

    const memo = poseMemos.get(renderable);
    if (
      memo?.tree === transformTree &&
      memo.renderFrame === renderFrame &&
      memo.fixedFrame === fixedFrame &&
      memo.srcFrame === srcFrame &&
      memo.renderFrameId === renderFrameId &&
      memo.fixedFrameId === fixedFrameId &&
      memo.srcFrameId === srcFrameId &&
      memo.srcTime === srcTimeKey &&
      memo.dstTime === dstTimeKey &&
      memo.pathVersion === pathVersion &&
      offsetRefsEqual(memo.offsetRefs, scratchSrcOffsets, scratchDstOffsets) &&
      poseValuesEqual(memo.poseValues, poseValues)
    ) {
      // Re-apply the cached result: values cannot have changed, but restoring
      // them keeps this function a full owner of the renderable pose.
      renderable.visible = memo.applied;
      if (memo.applied) {
        const p = memo.position;
        const q = memo.orientation;
        renderable.position.set(p.x, p.y, p.z);
        renderable.quaternion.set(q.x, q.y, q.z, q.w);
      }
      return memo.applied;
    }

    const applied = computePose(renderable, transformTree, renderFrameId, fixedFrameId, srcFrameId, dstTime, srcTime, pose);
    poseMemos.set(renderable, {
      tree: transformTree,
      renderFrame,
      fixedFrame,
      srcFrame,
      renderFrameId,
      fixedFrameId,
      srcFrameId,
      srcTime: srcTimeKey,
      dstTime: dstTimeKey,
      pathVersion,
      offsetRefs:
        scratchSrcOffsets.length + scratchDstOffsets.length === 0
          ? NO_OFFSETS
          : [...scratchSrcOffsets, ...scratchDstOffsets],
      poseValues,
      applied,
      position: { x: renderable.position.x, y: renderable.position.y, z: renderable.position.z },
      orientation: {
        x: renderable.quaternion.x,
        y: renderable.quaternion.y,
        z: renderable.quaternion.z,
        w: renderable.quaternion.w,
      },
    });
    return applied;
  }

  return computePose(renderable, transformTree, renderFrameId, fixedFrameId, srcFrameId, dstTime, srcTime, pose);
}

function computePose(
  renderable: THREE.Object3D,
  transformTree: TransformTree,
  renderFrameId: AnyFrameId,
  fixedFrameId: AnyFrameId,
  srcFrameId: string,
  dstTime: bigint,
  srcTime: bigint,
  pose: Readonly<Pose>,
): boolean {
  const poseApplied = Boolean(
    transformTree.apply(tempPose, pose, renderFrameId, fixedFrameId, srcFrameId, dstTime, srcTime),
  );
  renderable.visible = poseApplied;
  if (poseApplied) {
    const p = tempPose.position;
    const q = tempPose.orientation;
    renderable.position.set(p.x, p.y, p.z);
    renderable.quaternion.set(q.x, q.y, q.z, q.w);
  }
  return poseApplied;
}
