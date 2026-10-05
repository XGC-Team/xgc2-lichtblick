// SPDX-License-Identifier: MPL-2.0
import type { Channel } from "@foxglove/ws-protocol";
import * as base64 from "@protobufjs/base64";
import { parseChannel } from "@lichtblick/mcap-support";
const textEncoder = new TextEncoder();
export function parseLiveChannel(channel: Channel): ReturnType<typeof parseChannel> {
  let schemaEncoding;
  let schemaData;
  if (
    channel.encoding === "json" &&
    (channel.schemaEncoding == undefined || channel.schemaEncoding === "jsonschema")
  ) {
    schemaEncoding = "jsonschema";
    schemaData = textEncoder.encode(channel.schema);
  } else if (
    channel.encoding === "protobuf" &&
    (channel.schemaEncoding == undefined || channel.schemaEncoding === "protobuf")
  ) {
    schemaEncoding = "protobuf";
    schemaData = new Uint8Array(base64.length(channel.schema));
    if (base64.decode(channel.schema, schemaData, 0) !== schemaData.byteLength) {
      throw new Error(`Failed to decode base64 schema on channel ${channel.id}`);
    }
  } else if (
    channel.encoding === "flatbuffer" &&
    (channel.schemaEncoding == undefined || channel.schemaEncoding === "flatbuffer")
  ) {
    schemaEncoding = "flatbuffer";
    schemaData = new Uint8Array(base64.length(channel.schema));
    if (base64.decode(channel.schema, schemaData, 0) !== schemaData.byteLength) {
      throw new Error(`Failed to decode base64 schema on channel ${channel.id}`);
    }
  } else if (
    channel.encoding === "ros1" &&
    (channel.schemaEncoding == undefined || channel.schemaEncoding === "ros1msg")
  ) {
    schemaEncoding = "ros1msg";
    schemaData = textEncoder.encode(channel.schema);
  } else if (
    channel.encoding === "cdr" &&
    (channel.schemaEncoding == undefined ||
      ["ros2idl", "ros2msg", "omgidl"].includes(channel.schemaEncoding))
  ) {
    schemaEncoding = channel.schemaEncoding ?? "ros2msg";
    schemaData = textEncoder.encode(channel.schema);
  } else {
    const msg = channel.schemaEncoding
      ? `Unsupported combination of message / schema encoding: (${channel.encoding} / ${channel.schemaEncoding})`
      : `Unsupported message encoding ${channel.encoding}`;
    throw new Error(msg);
  }
  return parseChannel({
    messageEncoding: channel.encoding,
    schema: { name: channel.schemaName, encoding: schemaEncoding, data: schemaData },
  });
}
