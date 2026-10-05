// SPDX-License-Identifier: MPL-2.0
import * as THREE from "three";
import { makeStandardMaterial } from "./markers/materials";
import type { ColorRGBA } from "../ros";
import type { Renderable } from "../Renderable";

/** A view of the existing asset owner, never an independent model/robot registry. */
export type UrdfInstancePart = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  markerColor?: ColorRGBA;
  /** Static visual/mesh-node transform; the current absolute link pose is applied separately. */
  visualMatrix: THREE.Matrix4;
  source: Renderable;
  /** The same highest pickable ancestor returned by the original Renderer traversal. */
  logicalTarget: Renderable;
  sourceGeneration: number;
  isCurrent: () => boolean;
  renderOrder: number;
  castShadow: boolean;
  receiveShadow: boolean;
};

export type LogicalPickFence = {
  /** Original Object3D IDs, not instance slot numbers or whole-ID float attributes. */
  ids: readonly number[];
  isCurrent: (id: number) => boolean;
};

export function encodeLogicalObjectId(id: number, target: Uint8Array, offset: number): void {
  if (!Number.isSafeInteger(id) || id < 0 || id >= 0xffffffff) {
    throw new Error("Logical Object3D ID is outside the existing picking byte domain");
  }
  target[offset] = (id >>> 24) & 255;
  target[offset + 1] = (id >>> 16) & 255;
  target[offset + 2] = (id >>> 8) & 255;
  target[offset + 3] = id & 255;
}

/** Preserve original logical ancestors, including the whole URDF target when it is pickable. */
export function highestLogicalTarget(source: Renderable): Renderable {
  let target = source;
  for (let node: THREE.Object3D | null = source; node != undefined; node = node.parent) {
    if ((node as Partial<Renderable>).pickable === true) target = node as Renderable;
  }
  return target;
}

/** Both normal and selected sets use the original layer decisions; no all-fleet selected discard. */
export function logicalDrawLayer(part: UrdfInstancePart): "normal" | "selected" | "hidden" {
  if (!part.isCurrent()) return "hidden";
  for (let node: THREE.Object3D | null = part.source; node != undefined; node = node.parent) {
    if (!node.visible) return "hidden";
  }
  if ((part.source.layers.mask & (1 << 1)) !== 0) return "selected";
  return (part.source.layers.mask & 1) !== 0 ? "normal" : "hidden";
}

/** Picker's current pass may validate these IDs; it still resolves identity via scene.getObjectById. */
export function captureLogicalPickFence(parts: readonly UrdfInstancePart[]): LogicalPickFence {
  // Full submitted coverage, including now-hidden/retired owners. Never use fresh desired
  // membership to interpret an older GPU ID attribute submission.
  const submitted = parts.map((part) => ({
    part,
    id: part.logicalTarget.id,
    generation: part.sourceGeneration,
  }));
  return {
    ids: [...new Set(submitted.map((entry) => entry.id))],
    isCurrent: (id) =>
      submitted.some(
        (entry) =>
          entry.id === id &&
          entry.generation === entry.part.sourceGeneration &&
          entry.part.isCurrent() &&
          logicalDrawLayer(entry.part) !== "hidden",
      ),
  };
}

/** Each collection owns only its instance attributes/material binding, not asset geometry/textures. */
class InstanceDraw {
  public readonly mesh: THREE.InstancedMesh;
  readonly #geometry: THREE.BufferGeometry;
  readonly #capacity: number;
  readonly #mask: THREE.InstancedBufferAttribute;
  readonly #ids: THREE.InstancedBufferAttribute;
  readonly #normal: THREE.InstancedBufferAttribute[];
  #matrixMin = Infinity;
  #matrixMax = -1;
  #maskMin = Infinity;
  #maskMax = -1;
  #idsChanged = false;
  #normalMatrix = new THREE.Matrix3();
  #parts: readonly UrdfInstancePart[] = [];
  #pickFence: LogicalPickFence = captureLogicalPickFence([]);

  public constructor(
    base: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    layer: number,
  ) {
    this.#capacity = capacity;
    const geometry = new THREE.BufferGeometry();
    geometry.index = base.index;
    for (const [name, attribute] of Object.entries(base.attributes))
      geometry.setAttribute(name, attribute);
    geometry.groups = base.groups.map((group) => ({ ...group }));
    geometry.setDrawRange(base.drawRange.start, base.drawRange.count);
    this.#geometry = geometry;
    this.#mask = new THREE.InstancedBufferAttribute(new Uint8Array(capacity), 1);
    this.#ids = new THREE.InstancedBufferAttribute(new Uint8Array(capacity * 4), 4, true);
    this.#normal = [0, 1, 2].map(
      () => new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
    );
    geometry.setAttribute("xgcVisible", this.#mask);
    geometry.setAttribute("xgcLogicalId", this.#ids);
    this.#normal.forEach((attribute, index) =>
      geometry.setAttribute(`xgcNormal${index}`, attribute),
    );
    for (const attribute of [this.#mask, this.#ids, ...this.#normal])
      attribute.setUsage(THREE.DynamicDrawUsage);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.layers.set(layer);
    mesh.frustumCulled = false; // Model-level envelope decisions remain the existing Urdfs owner.
    mesh.count = 0;
    this.mesh = mesh;
    mesh.userData.logicalPickFence = () => this.#pickFence;
  }

  public get capacity(): number {
    return this.#capacity;
  }

  public setParts(parts: readonly UrdfInstancePart[]): void {
    this.#parts = [...parts];
    this.#pickFence = captureLogicalPickFence(this.#parts);
    this.mesh.count = parts.length;
    for (let slot = 0; slot < parts.length; slot++)
      encodeLogicalObjectId(parts[slot]!.logicalTarget.id, this.#ids.array as Uint8Array, slot * 4);
    if (parts.length > 0) {
      this.#ids.updateRange.offset = 0;
      this.#ids.updateRange.count = parts.length * 4;
      this.#ids.needsUpdate = true;
      this.#idsChanged = true;
    }
  }

  public setMask(slot: number, visible: boolean): void {
    const value = visible ? 1 : 0;
    if (this.#mask.getX(slot) === value) return;
    this.#mask.setX(slot, value);
    this.#maskMin = Math.min(this.#maskMin, slot);
    this.#maskMax = Math.max(this.#maskMax, slot);
  }

  public setMatrix(slot: number, value: THREE.Matrix4): void {
    const array = this.mesh.instanceMatrix.array;
    const elements = value.elements;
    let changed = false;
    for (let component = 0; component < 16; component++) {
      if (array[slot * 16 + component] !== Math.fround(elements[component]!)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.mesh.setMatrixAt(slot, value);
    const normal = this.#normalMatrix.getNormalMatrix(value).elements;
    for (let column = 0; column < 3; column++)
      this.#normal[column]!.setXYZ(
        slot,
        normal[column * 3]!,
        normal[column * 3 + 1]!,
        normal[column * 3 + 2]!,
      );
    this.#matrixMin = Math.min(this.#matrixMin, slot);
    this.#matrixMax = Math.max(this.#matrixMax, slot);
  }

  public flush(): boolean {
    const changed =
      this.#idsChanged || this.#matrixMax >= this.#matrixMin || this.#maskMax >= this.#maskMin;
    if (this.#matrixMax >= this.#matrixMin) {
      this.mesh.instanceMatrix.updateRange.offset = this.#matrixMin * 16;
      this.mesh.instanceMatrix.updateRange.count = (this.#matrixMax - this.#matrixMin + 1) * 16;
      this.mesh.instanceMatrix.needsUpdate = true;
      for (const attribute of this.#normal) {
        attribute.updateRange.offset = this.#matrixMin * 3;
        attribute.updateRange.count = (this.#matrixMax - this.#matrixMin + 1) * 3;
        attribute.needsUpdate = true;
      }
    }
    if (this.#maskMax >= this.#maskMin) {
      this.#mask.updateRange.offset = this.#maskMin;
      this.#mask.updateRange.count = this.#maskMax - this.#maskMin + 1;
      this.#mask.needsUpdate = true;
    }
    this.#matrixMin = this.#maskMin = Infinity;
    this.#matrixMax = this.#maskMax = -1;
    this.#idsChanged = false;
    return changed;
  }

  public dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose(); // Own instanceMatrix only.
    // Detach cache-owned attributes/index before releasing this wrapper's own instance attributes.
    const owned = [this.#mask, this.#ids, ...this.#normal];
    for (const [name, attribute] of Object.entries(this.#geometry.attributes))
      if (!owned.some((own) => own === attribute)) this.#geometry.deleteAttribute(name);
    this.#geometry.index = null;
    this.#geometry.dispose();
  }
}

type InstanceGroup = {
  parts: UrdfInstancePart[];
  material: THREE.Material;
  picking: THREE.ShaderMaterial;
  normal: InstanceDraw;
  selected?: InstanceDraw;
  selectedParts: readonly UrdfInstancePart[];
};

/** Actual draw-slot owner inside the existing Urdfs extension; no second logical identity table. */
export class UrdfVisualInstances extends THREE.Group {
  #groups: InstanceGroup[] = [];
  #submissionChanged = false;
  readonly #matrix = new THREE.Matrix4();
  readonly #poseState = new WeakMap<
    Renderable,
    { values: number[]; parent: THREE.Object3D | null; parentMatrix: number[] }
  >();
  #updateSourceWorld(source: Renderable): void {
    const p = source.position,
      q = source.quaternion,
      s = source.scale;
    const parentMatrix = source.parent?.matrixWorld.elements;
    let previous = this.#poseState.get(source);
    let changed = previous == undefined || previous.parent !== source.parent;
    if (previous != undefined) {
      const v = previous.values;
      changed ||=
        v[0] !== p.x ||
        v[1] !== p.y ||
        v[2] !== p.z ||
        v[3] !== q.x ||
        v[4] !== q.y ||
        v[5] !== q.z ||
        v[6] !== q.w ||
        v[7] !== s.x ||
        v[8] !== s.y ||
        v[9] !== s.z;
      for (let i = 0; i < (parentMatrix?.length ?? 0); i++)
        if (parentMatrix![i] !== previous.parentMatrix[i]) {
          changed = true;
          break;
        }
    }
    if (!changed) return;
    source.updateWorldMatrix(true, false);
    if (previous == undefined) {
      previous = { values: new Array<number>(10), parent: source.parent, parentMatrix: [] };
      this.#poseState.set(source, previous);
    }
    const v = previous.values;
    v[0] = p.x;
    v[1] = p.y;
    v[2] = p.z;
    v[3] = q.x;
    v[4] = q.y;
    v[5] = q.z;
    v[6] = q.w;
    v[7] = s.x;
    v[8] = s.y;
    v[9] = s.z;
    previous.parent = source.parent;
    for (let i = 0; i < (parentMatrix?.length ?? 0); i++)
      previous.parentMatrix[i] = parentMatrix![i]!;
    previous.parentMatrix.length = parentMatrix?.length ?? 0;
  }

  public replaceParts(parts: readonly UrdfInstancePart[]): void {
    const compatible: {
      geometry: THREE.BufferGeometry;
      binding: UrdfInstancePart;
      parts: UrdfInstancePart[];
    }[] = [];
    for (const part of parts) {
      const group = compatible.find(
        (group) => group.geometry === part.geometry && drawEquivalent(group.binding, part),
      );
      if (group != undefined) group.parts.push(part);
      else compatible.push({ geometry: part.geometry, binding: part, parts: [part] });
    }
    const replacements: InstanceGroup[] = [];
    try {
      for (const group of compatible) {
        const geometry = group.geometry,
          baseMaterial = group.binding.material,
          members = group.parts;
        const markerMaterial =
          members[0]!.markerColor == undefined
            ? undefined
            : makeStandardMaterial(members[0]!.markerColor!);
        const binding = markerMaterial ?? baseMaterial;
        const material = instanceMaterial(binding);
        const picking = instancePickingMaterial(binding);
        markerMaterial?.dispose();
        const normal = new InstanceDraw(geometry, material, members.length, 0);
        normal.mesh.renderOrder = members[0]!.renderOrder;
        normal.mesh.castShadow = members[0]!.castShadow;
        normal.mesh.receiveShadow = members[0]!.receiveShadow;
        normal.mesh.userData.pickingMaterial = picking;
        normal.setParts(members);
        replacements.push({ parts: members, material, picking, normal, selectedParts: [] });
      }
    } catch (error) {
      for (const group of replacements) releaseGroup(group);
      throw error;
    }
    const previous = this.#groups;
    this.#groups = replacements;
    this.#submissionChanged = true;
    for (const group of replacements) this.add(group.normal.mesh);
    for (const group of previous) releaseGroup(group);
  }

  public prepareDraw(): boolean {
    let renderListChanged = this.#submissionChanged;
    this.#submissionChanged = false;
    for (const group of this.#groups) {
      const selected: UrdfInstancePart[] = [];
      let anyNormal = false;
      for (let slot = 0; slot < group.parts.length; slot++) {
        const part = group.parts[slot]!;
        const layer = logicalDrawLayer(part);
        group.normal.setMask(slot, layer === "normal");
        anyNormal ||= layer === "normal";
        if (layer === "hidden") continue;
        this.#updateSourceWorld(part.source);
        this.#matrix.multiplyMatrices(part.source.matrixWorld, part.visualMatrix);
        if (this.#matrix.determinant() <= 0)
          throw new Error("Unsupported mirrored visual transform reached instance submission");
        group.normal.setMatrix(slot, this.#matrix);
        if (layer === "selected") selected.push(part);
      }
      if (group.normal.mesh.visible !== anyNormal) {
        group.normal.mesh.visible = anyNormal;
        renderListChanged = true;
      }
      renderListChanged = group.normal.flush() || renderListChanged;
      // The selected pass contains only selected compatible parts, not a fleet-sized discard draw.
      const changed =
        selected.length !== group.selectedParts.length ||
        selected.some((part, index) => part !== group.selectedParts[index]);
      if (
        selected.length > 0 &&
        (group.selected == undefined || selected.length > group.selected.capacity)
      ) {
        const capacity = Math.max(
          selected.length,
          Math.ceil((group.selected?.capacity ?? 0) * 1.5),
        );
        const draw = new InstanceDraw(group.parts[0]!.geometry, group.material, capacity, 1);
        draw.mesh.renderOrder = group.normal.mesh.renderOrder;
        draw.mesh.userData.pickingMaterial = group.picking;
        group.selected?.dispose();
        group.selected = draw;
        this.add(draw.mesh);
        renderListChanged = true;
      }
      if (changed) {
        group.selectedParts = selected;
        group.selected?.setParts(selected);
        renderListChanged = true;
      }
      if (group.selected != undefined) {
        for (let slot = 0; slot < selected.length; slot++) {
          const part = selected[slot]!;
          this.#matrix.multiplyMatrices(part.source.matrixWorld, part.visualMatrix);
          group.selected.setMatrix(slot, this.#matrix);
          group.selected.setMask(slot, true);
        }
        renderListChanged = group.selected.flush() || renderListChanged;
      }
    }
    return renderListChanged;
  }

  public dispose(): void {
    for (const group of this.#groups) releaseGroup(group);
    this.#groups = [];
  }
}

function releaseGroup(group: InstanceGroup): void {
  group.normal.dispose();
  group.selected?.dispose();
  group.material.dispose();
  group.picking.dispose();
}

function instanceMaterial(original: THREE.Material): THREE.Material {
  const material = original.clone();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "attribute float xgcVisible; attribute vec3 xgcNormal0; attribute vec3 xgcNormal1; attribute vec3 xgcNormal2; varying float xgcVisibility;\n" +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      "void main() { xgcVisibility=xgcVisible;",
    );
    const normal = THREE.ShaderChunk.defaultnormal_vertex.replace(
      "mat3 m = mat3( instanceMatrix );",
      "mat3 m = mat3(xgcNormal0,xgcNormal1,xgcNormal2);",
    );
    const exactNormal = normal
      .replace(/transformedNormal \/= vec3\([^;]+;/, "")
      .replace(
        "( modelViewMatrix * vec4( objectTangent, 0.0 ) ).xyz",
        "( modelViewMatrix * instanceMatrix * vec4( objectTangent, 0.0 ) ).xyz",
      );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <defaultnormal_vertex>",
      exactNormal,
    );
    shader.fragmentShader = "varying float xgcVisibility;\n" + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "void main() {",
      "void main() { if(xgcVisibility<0.5) discard;",
    );
  };
  material.customProgramCacheKey = () => "xgc-opaque-visual-exact-normal";
  return material;
}

function instancePickingMaterial(original: THREE.Material): THREE.ShaderMaterial {
  const vertexShader = THREE.ShaderChunk.meshbasic_vert.replace(
    "void main() {",
    "attribute vec4 xgcLogicalId; attribute float xgcVisible; varying vec4 logicalId; varying float visibility; void main() { logicalId=xgcLogicalId; visibility=xgcVisible;",
  );
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader:
      "varying vec4 logicalId; varying float visibility; void main(){ if(visibility<0.5)discard;gl_FragColor=logicalId; }",
    side: THREE.DoubleSide,
    depthTest: original.depthTest,
    depthWrite: original.depthWrite,
    uniforms: { objectId: { value: [NaN, NaN, NaN, NaN] } },
  });
}

export type UrdfVisualGeometryPart = Pick<
  UrdfInstancePart,
  | "geometry"
  | "material"
  | "markerColor"
  | "visualMatrix"
  | "renderOrder"
  | "castShadow"
  | "receiveShadow"
>;
export function supportsOpaqueVisual(mesh: THREE.Mesh, markerColor?: ColorRGBA): boolean {
  const material = mesh.material;
  return (
    mesh.onBeforeRender === THREE.Object3D.prototype.onBeforeRender &&
    mesh.onAfterRender === THREE.Object3D.prototype.onAfterRender &&
    !(mesh as THREE.SkinnedMesh).isSkinnedMesh &&
    !mesh.morphTargetInfluences?.length &&
    !Array.isArray(material) &&
    (markerColor != undefined
      ? markerColor.a === 1
      : !material.transparent &&
        material.opacity === 1 &&
        (material instanceof THREE.MeshStandardMaterial ||
          material instanceof THREE.MeshBasicMaterial ||
          material instanceof THREE.MeshLambertMaterial ||
          material instanceof THREE.MeshPhongMaterial) &&
        material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile &&
        material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey)
  );
}

/** Cold-path exact draw equivalence, including texture references; no clone UUID/version authority. */
function drawEquivalent(a: UrdfInstancePart, b: UrdfInstancePart): boolean {
  if (
    a.renderOrder !== b.renderOrder ||
    a.castShadow !== b.castShadow ||
    a.receiveShadow !== b.receiveShadow
  )
    return false;
  if (a.markerColor != undefined || b.markerColor != undefined) {
    return (
      a.markerColor != undefined &&
      b.markerColor != undefined &&
      a.markerColor.a === 1 &&
      b.markerColor.a === 1 &&
      a.markerColor.r === b.markerColor.r &&
      a.markerColor.g === b.markerColor.g &&
      a.markerColor.b === b.markerColor.b
    );
  }
  const ignored = new Set(["id", "uuid", "name", "version", "_listeners"]);
  const left = Object.keys(a.material).filter((key) => !ignored.has(key));
  const right = Object.keys(b.material).filter((key) => !ignored.has(key));
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b.material, key) &&
        equivalentValue(
          (a.material as unknown as Record<string, unknown>)[key],
          (b.material as unknown as Record<string, unknown>)[key],
        ),
    )
  );
}
function equivalentValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof THREE.Texture || b instanceof THREE.Texture) return false; // Exact resource binding identity.
  if (a instanceof THREE.Color && b instanceof THREE.Color) return a.equals(b);
  if (a instanceof THREE.Vector2 && b instanceof THREE.Vector2) return a.equals(b);
  if (a instanceof THREE.Vector3 && b instanceof THREE.Vector3) return a.equals(b);
  if (a instanceof THREE.Vector4 && b instanceof THREE.Vector4) return a.equals(b);
  if (a instanceof THREE.Matrix3 && b instanceof THREE.Matrix3) return a.equals(b);
  if (a instanceof THREE.Matrix4 && b instanceof THREE.Matrix4) return a.equals(b);
  if (a instanceof THREE.Plane && b instanceof THREE.Plane) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => equivalentValue(value, b[index]));
  if (
    a != undefined &&
    b != undefined &&
    typeof a === "object" &&
    typeof b === "object" &&
    Object.getPrototypeOf(a) === Object.prototype &&
    Object.getPrototypeOf(b) === Object.prototype
  ) {
    const left = Object.keys(a),
      right = Object.keys(b);
    return (
      left.length === right.length &&
      left.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(b, key) &&
          equivalentValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}
