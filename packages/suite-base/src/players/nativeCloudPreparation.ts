// SPDX-License-Identifier: MPL-2.0
import type { MessageEvent } from "@lichtblick/suite";
import type { LayerSettingsPointClouds } from "../panels/ThreeDeeRender/renderables/PointClouds";
import type { PreparedOccupancyGrid } from "../panels/ThreeDeeRender/renderables/occupancyGrids/prepareOccupancyGrid";
import type { PreparedPointCloud } from "../panels/ThreeDeeRender/renderables/pointClouds/preparePointCloud";

export type NativeCloudProvenance = {
  channel: object;
  subscriptionId: number;
  generation: number;
  ingressSequence: number;
};
// Metadata only: the original event remains owned by the existing pipeline latest-message map.
const provenance = new WeakMap<object, NativeCloudProvenance>();
export function setNativeCloudProvenance(event: MessageEvent, value: NativeCloudProvenance): void {
  provenance.set(event, value);
}
export function getNativeCloudProvenance(event: object): NativeCloudProvenance | undefined {
  return provenance.get(event);
}
export type NativeCloudCommitUsage = {
  cpuArrays: readonly ArrayBufferView[];
  gpuCapacityBytes: number;
  growOverlapBytes: number;
};
export type PreparedNativeSample =
  | ({ kind: "pointcloud" } & PreparedPointCloud)
  | ({ kind: "occupancy-grid" } & PreparedOccupancyGrid);

type PreparationInputs =
  | {
      kind: "pointcloud";
      settings: LayerSettingsPointClouds;
      capacity: () => number;
      canReuseCoordinates: (event: MessageEvent) => boolean;
    }
  | { kind: "occupancy-grid"; settings: { palette: Uint8ClampedArray } };
type PreparationOwner = {
  key: object;
  revision: string;
  inputKey: string;
  setEnabled: (enabled: boolean) => void;
  invalidCloud: (message: string) => void;
  usage: () => NativeCloudCommitUsage;
};
export type NativeCloudPreparation = PreparationOwner &
  PreparationInputs & {
    commit: (
      event: MessageEvent,
      prepared: PreparedNativeSample,
    ) => NativeCloudCommitUsage | undefined;
  };
export type NativeCloudConsumer = PreparationOwner &
  PreparationInputs & {
    identity: object;
    parked: boolean;
    isActive: () => boolean;
    latest: () => MessageEvent | undefined;
    commit: (
      event: MessageEvent,
      prepared: PreparedNativeSample,
    ) => NativeCloudCommitUsage | undefined;
  };

export function nativePreparedArrays(prepared: PreparedNativeSample): readonly ArrayBufferView[] {
  return prepared.kind === "occupancy-grid"
    ? [prepared.occupancyGrid.data, prepared.rgba]
    : [
        prepared.positions,
        prepared.colors,
        prepared.stixelPositions,
        prepared.stixelColors,
        prepared.pointCloud.data,
      ];
}

export function shouldRetainNativeCloud(event: object, current: object | undefined): boolean {
  const incoming = getNativeCloudProvenance(event),
    previous = current && getNativeCloudProvenance(current);
  if (incoming == undefined || previous == undefined) return true;
  return (
    incoming.generation > previous.generation ||
    (incoming.generation === previous.generation &&
      incoming.ingressSequence >= previous.ingressSequence)
  );
}
