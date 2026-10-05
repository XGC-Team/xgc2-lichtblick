import { estimateObjectSize } from "../messageMemoryEstimation";
// SPDX-License-Identifier: MPL-2.0
import type { Channel } from "@foxglove/ws-protocol";
import type { MessageEvent as SuiteMessageEvent } from "@lichtblick/suite";
import { nativePreparedArrays, type PreparedNativeSample } from "../nativeCloudPreparation";
import type { LayerSettingsPointClouds } from "../../panels/ThreeDeeRender/renderables/PointClouds";
import { prepareOccupancyGrid } from "../../panels/ThreeDeeRender/renderables/occupancyGrids/prepareOccupancyGrid";
import { preparePointCloud } from "../../panels/ThreeDeeRender/renderables/pointClouds/preparePointCloud";
import { parseLiveChannel } from "./parseLiveChannel";
type CloudPrepRequestBase = {
  id: number;
  channelToken: number;
  generation: number;
  channel: Channel;
  raw?: Uint8Array;
  event?: SuiteMessageEvent;
  receiveTime: SuiteMessageEvent["receiveTime"];
  inputKey: string;
};
export type CloudPrepRequest = CloudPrepRequestBase &
  (
    | {
        kind: "pointcloud";
        settings: LayerSettingsPointClouds;
        capacity: number;
        deriveCoordinates: boolean;
      }
    | { kind: "occupancy-grid"; settings: { palette: Uint8ClampedArray } }
  );
export type CloudPrepWorkingSet = {
  inputBackingBytes: number;
  derivedCapacityBytes: number;
  ownedBackingPeakBytes: number;
};
export type CloudPrepResponse = (
  | { id: number; inputKey: string; event: SuiteMessageEvent; prepared: PreparedNativeSample }
  | { id: number; error: string; invalidCloud?: boolean }
) & { workingSet?: CloudPrepWorkingSet };
const sendWithTransfer: (message: CloudPrepResponse, transfer: Transferable[]) => void =
  self.postMessage;
const send: (message: CloudPrepResponse) => void = self.postMessage;
const parsers = new Map<number, ReturnType<typeof parseLiveChannel>>();
self.onmessage = (message: MessageEvent<CloudPrepRequest | { releaseChannel: number }>) => {
  if ("releaseChannel" in message.data) {
    parsers.delete(message.data.releaseChannel);
    return;
  }
  const job = message.data;
  let invalidCloud = false;
  const sourceData = (job.event?.message as { data?: unknown } | undefined)?.data;
  const inputBackings = new Set<ArrayBufferLike>();
  if (job.raw != undefined) inputBackings.add(job.raw.buffer);
  if (ArrayBuffer.isView(sourceData)) inputBackings.add(sourceData.buffer);
  if (job.kind === "occupancy-grid") inputBackings.add(job.settings.palette.buffer);
  const workingSet: CloudPrepWorkingSet = {
    inputBackingBytes: [...inputBackings].reduce((n, b) => n + b.byteLength, 0),
    derivedCapacityBytes: 0,
    ownedBackingPeakBytes: 0,
  };
  workingSet.ownedBackingPeakBytes = workingSet.inputBackingBytes;
  const allocated = (arrays: readonly ArrayBufferView[]) => {
    const backings = new Set(arrays.map((array) => array.buffer));
    workingSet.derivedCapacityBytes = Math.max(
      workingSet.derivedCapacityBytes,
      [...backings].reduce((n, b) => n + (inputBackings.has(b) ? 0 : b.byteLength), 0),
    );
    const owned = new Set([...inputBackings, ...backings]);
    workingSet.ownedBackingPeakBytes = Math.max(
      workingSet.ownedBackingPeakBytes,
      [...owned].reduce((n, b) => n + b.byteLength, 0),
    );
  };
  try {
    let parser = parsers.get(job.channelToken);
    if (parser == undefined) {
      parser = parseLiveChannel(job.channel);
      parsers.set(job.channelToken, parser);
    }
    const event: SuiteMessageEvent = job.event ?? {
      topic: job.channel.topic,
      schemaName: job.channel.schemaName,
      receiveTime: job.receiveTime,
      sizeInBytes: job.raw!.byteLength,
      message: parser!.deserialize(job.raw!),
    };
    if (job.event == undefined)
      event.sizeInBytes = Math.max(event.sizeInBytes, estimateObjectSize(event.message));
    invalidCloud = true;
    const prepared: PreparedNativeSample =
      job.kind === "occupancy-grid"
        ? {
            kind: "occupancy-grid",
            ...prepareOccupancyGrid(event.message, job.settings.palette, allocated),
          }
        : {
            kind: "pointcloud",
            ...preparePointCloud(
              event.message,
              event.schemaName,
              job.settings,
              job.capacity,
              job.deriveCoordinates,
              allocated,
            ),
          };
    const transfers = new Set<ArrayBuffer>();
    for (const array of nativePreparedArrays(prepared)) {
      if (array.buffer instanceof ArrayBuffer) transfers.add(array.buffer);
    }
    // These arrays were allocated by this job and are immutable after ownership moves to main.
    sendWithTransfer({ id: job.id, inputKey: job.inputKey, event, prepared, workingSet }, [
      ...transfers,
    ]);
  } catch (error) {
    send({
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
      invalidCloud,
      workingSet,
    });
  }
};
