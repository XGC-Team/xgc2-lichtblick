// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { normalizeTFMessage } from "./normalizeMessages";

describe("normalizeTFMessage", () => {
  it("returns fully populated messages by identity without rebuilding objects", () => {
    const message = {
      transforms: [
        {
          header: { stamp: { sec: 1, nsec: 2 }, frame_id: "world", seq: 7 },
          child_frame_id: "base_link",
          transform: {
            translation: { x: 1, y: 2, z: 3 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
      ],
    };
    expect(normalizeTFMessage(message)).toBe(message);
  });

  it("returns an empty transform list by identity", () => {
    const message = { transforms: [] };
    expect(normalizeTFMessage(message)).toBe(message);
  });

  it("normalizes messages with missing fields", () => {
    const message = { transforms: [{ child_frame_id: "base_link" }] };
    const result = normalizeTFMessage(message);
    expect(result).not.toBe(message);
    expect(result.transforms).toEqual([
      {
        header: { frame_id: "", stamp: { sec: 0, nsec: 0 }, seq: undefined },
        child_frame_id: "base_link",
        transform: {
          translation: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
    ]);
  });

  it("normalizes the whole message when any transform is incomplete", () => {
    const complete = {
      header: { stamp: { sec: 1, nsec: 2 }, frame_id: "world" },
      child_frame_id: "a",
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
    const incomplete = { header: { frame_id: "world" }, child_frame_id: "b" };
    const message = { transforms: [complete, incomplete] };
    const result = normalizeTFMessage(message);
    expect(result).not.toBe(message);
    expect(result.transforms).toHaveLength(2);
    expect(result.transforms[1]!.transform.rotation.w).toBe(1);
  });

  it("treats missing rotation w as incomplete rather than defaulting silently", () => {
    const message = {
      transforms: [
        {
          header: { stamp: { sec: 1, nsec: 2 }, frame_id: "world" },
          child_frame_id: "base_link",
          transform: {
            translation: { x: 1, y: 2, z: 3 },
            rotation: { x: 0, y: 0, z: 0 },
          },
        },
      ],
    };
    const result = normalizeTFMessage(message);
    expect(result).not.toBe(message);
    expect(result.transforms[0]!.transform.rotation).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });
});
