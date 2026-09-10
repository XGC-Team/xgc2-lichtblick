// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { canRetrySync } from "./sceneSync";
import { parseSceneEnvelope, type SceneEnvelope } from "./types";

function envelope(
  consumers: SceneEnvelope["consumers"],
  synchronized = false,
): SceneEnvelope {
  return {
    epoch: "e",
    revision: 3,
    savedRevision: 3,
    dirty: false,
    playing: false,
    sceneTime: 0,
    synchronized,
    consumers,
    document: {
      schema: "xgc2.scene.v1",
      id: "test",
      frame: "world",
      obstacles: [],
    },
  };
}

describe("scene sync retry policy", () => {
  it("uses applied as the only document-apply authority", () => {
    expect(
      canRetrySync(
        envelope([
          {
            consumer: "gazebo",
            epoch: "e",
            revision: 3,
            applied: false,
            operational: false,
            capability: "",
            success: false,
            message: "factory timeout",
          },
        ]),
      ),
    ).toBe(true);
    expect(() =>
      parseSceneEnvelope(
        envelope([
          {
            consumer: "gazebo",
            epoch: "e",
            revision: 3,
            applied: false,
            operational: false,
            capability: "",
            success: true,
            message: "stale success must not apply",
          },
        ]),
      ),
    ).toThrow("Invalid scene synchronization status.");
  });

  it("does not offer retry for a declared capability gap on the current version", () => {
    expect(
      canRetrySync(
        envelope([
          {
            consumer: "gazebo",
            epoch: "e",
            revision: 3,
            applied: true,
            operational: true,
            capability: "ok",
            success: true,
            message: "applied",
          },
          {
            consumer: "ugv-reset",
            epoch: "e",
            revision: 3,
            applied: false,
            operational: false,
            capability: "unsupported",
            success: false,
            message: "unsupported motion type: spiral",
          },
        ]),
      ),
    ).toBe(false);
  });

  it("still offers retry for version lag and apply transport failure", () => {
    expect(
      canRetrySync(
        envelope([
          {
            consumer: "gazebo",
            epoch: "e",
            revision: 2,
            applied: true,
            operational: true,
            capability: "ok",
            success: true,
            message: "old",
          },
        ]),
      ),
    ).toBe(true);
  });

  it("does not treat an applied capability warning as unsynchronized retry work", () => {
    expect(
      canRetrySync(
        envelope(
          [
            {
              consumer: "ugv-reset",
              epoch: "e",
              revision: 3,
              applied: true,
              operational: false,
              capability: "unsupported",
              success: true,
              message: "Reset cannot certify this motion",
            },
          ],
          true,
        ),
      ),
    ).toBe(false);
  });
});
