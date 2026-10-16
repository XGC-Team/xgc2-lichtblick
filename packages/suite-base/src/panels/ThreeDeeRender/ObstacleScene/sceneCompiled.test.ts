// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { SceneGeometryTable } from "./sceneRenderTable";
import {
  authoredObstacle,
  parseSceneEnvelope,
  sceneModelLabel,
  type SceneGeometry,
  type ScenePose,
} from "./types";

const pose: ScenePose = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };

function envelope(document: Record<string, unknown>, compiled?: Record<string, unknown>) {
  return {
    epoch: "epoch",
    revision: 1,
    savedRevision: 1,
    dirty: false,
    playing: false,
    sceneTime: 0,
    consumers: [],
    document,
    ...(compiled ? { compiled } : {}),
  };
}

function source(extra: Record<string, unknown> = {}) {
  return {
    schema: "xgc2.scene.v1",
    id: "yard",
    frame: "world",
    ...extra,
  };
}

describe("scene source and compiled contract", () => {
  it("keeps omitted ground as the default plane and rejects a second terrain owner", () => {
    const parsed = parseSceneEnvelope(envelope(source({ obstacles: [] })));
    expect(parsed.document).not.toHaveProperty("ground");
    expect(parsed).not.toHaveProperty("compiled");
    expect(() =>
      parseSceneEnvelope(envelope(source({ obstacles: [], terrain: { mode: "mesh" } }))),
    ).toThrow("Invalid scene document");
  });

  it("stores canonical waypoint metadata and rejects the old point list", () => {
    const parsed = parseSceneEnvelope(
      envelope(
        source({
          obstacles: [
            {
              id: "path-1",
              name: "Path",
              pose: { position: [4, 5, 6], orientation: [0, 0, 0, 1] },
              motion: {
                type: "waypoints",
                waypoints: [
                  [0, 0, 0],
                  [1, 0, 0],
                ],
              },
              parts: [
                {
                  id: "body",
                  pose,
                  geometry: { type: "box", size: [1, 1, 1] },
                  color: [1, 0.5, 0.1, 1],
                },
              ],
            },
          ],
        }),
      ),
    );
    expect(parsed.document.obstacles[0]?.pose.position).toEqual([4, 5, 6]);
    expect(parsed.document.obstacles[0]?.motion).toEqual({
      type: "waypoints",
      waypoints: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      velocity: 1,
      orientation: true,
      angular_velocity: 0.8,
      loop: false,
      sin: false,
    });
    expect(JSON.stringify(parsed.document.obstacles[0]?.motion)).not.toContain("align_yaw");
    expect(() =>
      parseSceneEnvelope(
        envelope(
          source({
            obstacles: [
              {
                id: "path-1",
                name: "Path",
                pose,
                motion: {
                  type: "waypoints",
                  points: [
                    [0, 0, 0],
                    [1, 0, 0],
                  ],
                  speed: 1,
                  loop: true,
                  align_yaw: true,
                  phase: 0,
                },
                parts: [
                  {
                    id: "body",
                    pose,
                    geometry: { type: "box", size: [1, 1, 1] },
                    color: [1, 0.5, 0.1, 1],
                  },
                ],
              },
            ],
          }),
        ),
      ),
    ).toThrow("Invalid obstacle");
  });

  it("parses a model reference without copying the resource file into the obstacle", () => {
    const parsed = parseSceneEnvelope(
      envelope(
        source({
          models: {
            jersey: {
              name: "Jersey barrier",
              resource: { format: "sdformat-model", file: "models/jersey_barrier/model.sdf" },
            },
          },
          obstacles: [
            { id: "barrier-1", name: "North", pose, motion: { type: "hold" }, model: "jersey" },
          ],
        }),
      ),
    );
    expect(sceneModelLabel("jersey", parsed.document.models?.jersey)).toBe("Jersey barrier");
    expect(sceneModelLabel("jersey", parsed.document.models?.jersey)).not.toContain("sdf");
    expect(parsed.document.obstacles[0]).toMatchObject({ model: "jersey" });
    expect(parsed.document.obstacles[0]).not.toHaveProperty("parts");
    expect(JSON.stringify(parsed.document.obstacles[0])).not.toContain("model.sdf");
    expect(JSON.stringify(parsed.document.obstacles[0])).not.toContain("parts");
    expect(parsed.document.models?.jersey?.resource?.file).toBe("models/jersey_barrier/model.sdf");
  });

  it("rejects inline parts mixed with a model reference", () => {
    expect(() =>
      parseSceneEnvelope(
        envelope(
          source({
            models: {
              box: {
                parts: [
                  {
                    id: "body",
                    pose,
                    geometry: { type: "box", size: [1, 1, 1] },
                    color: [1, 0, 0, 1],
                  },
                ],
              },
            },
            obstacles: [
              {
                id: "box-1",
                name: "Box",
                pose,
                motion: { type: "hold" },
                model: "box",
                parts: [
                  {
                    id: "body",
                    pose,
                    geometry: { type: "box", size: [1, 1, 1] },
                    color: [1, 0, 0, 1],
                  },
                ],
              },
            ],
          }),
        ),
      ),
    ).toThrow("not both");
    expect(() =>
      parseSceneEnvelope(
        envelope(
          source({
            models: {
              box: {
                parts: [
                  {
                    id: "body",
                    pose,
                    geometry: { type: "box", size: [1, 1, 1] },
                    color: [1, 0, 0, 1],
                  },
                ],
              },
            },
            obstacles: [
              { id: "box-1", name: "Box", pose, motion: { type: "hold" }, model: "box", parts: [] },
            ],
          }),
        ),
      ),
    ).toThrow("not both");
  });

  it("rejects a compiled scene whose id or frame is not this document", () => {
    const compiled = {
      schema: "xgc2.scene.compiled.v1",
      id: "other",
      frame: "world",
      ground: { mode: "none" },
      geometries: [],
      models: {},
      obstacles: [],
    };
    expect(() => parseSceneEnvelope(envelope(source({ obstacles: [] }), compiled))).toThrow(
      "compiled.v1 for this document",
    );
    expect(() =>
      parseSceneEnvelope(
        envelope(source({ obstacles: [] }), { ...compiled, id: "yard", frame: "map" }),
      ),
    ).toThrow("compiled.v1 for this document");
  });

  it("parses compiled.v1 without replacing the author model", () => {
    const triangle: SceneGeometry = {
      type: "mesh",
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      triangles: [0, 1, 2],
    };
    const parsed = parseSceneEnvelope(
      envelope(
        source({
          ground: { mode: "none" },
          models: {
            jersey: {
              name: "Jersey barrier",
              resource: { format: "mesh", file: "models/jersey.glb" },
            },
          },
          obstacles: [
            {
              id: "barrier-1",
              name: "North",
              pose,
              motion: {
                type: "waypoints",
                waypoints: [
                  [0, 0, 0],
                  [1, 0, 0],
                ],
                velocity: 1,
                orientation: true,
                angular_velocity: 0.8,
                loop: false,
                sin: false,
              },
              model: "jersey",
            },
          ],
        }),
        {
          schema: "xgc2.scene.compiled.v1",
          id: "yard",
          frame: "world",
          ground: { mode: "none" },
          geometries: [triangle],
          models: {
            jersey: {
              parts: [{ id: "collision", pose, geometryIndex: 0, color: [0.1, 0.2, 0.3, 1] }],
              resource: { format: "mesh", file: "models/jersey.glb" },
            },
          },
          obstacles: [
            {
              id: "barrier-1",
              name: "North",
              model: "jersey",
              pose,
              motion: {
                type: "waypoints",
                waypoints: [
                  [0, 0, 0],
                  [1, 0, 0],
                ],
                velocity: 1,
                orientation: true,
                angular_velocity: 0.8,
                loop: false,
                sin: false,
              },
            },
          ],
        },
      ),
    );
    expect(parsed.compiled?.geometries[0]).toEqual(triangle);
    expect(parsed.document.obstacles[0]).not.toHaveProperty("parts");
    expect(parsed.document.models?.jersey).not.toHaveProperty("parts");
    parsed.compiled?.models.jersey?.parts.push({
      id: "extra",
      pose,
      geometryIndex: 0,
      color: [1, 1, 1, 1],
    });
    expect(parsed.document.obstacles[0]).not.toHaveProperty("parts");
    expect(() =>
      parseSceneEnvelope(
        envelope(source({ obstacles: [] }), {
          schema: "xgc2.scene.compiled.v1",
          id: "yard",
          frame: "world",
          ground: { mode: "none" },
          geometries: [{ ...triangle, triangles: [[0, 1, 2]] }],
          models: {},
          obstacles: [],
        }),
      ),
    ).toThrow("compiled");
  });

  it("keeps bakeResource unparsed notes beside the collision mesh", () => {
    const mesh: SceneGeometry = {
      type: "mesh",
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      triangles: [0, 1, 2],
    };
    const file = "/var/lib/xgc/assets/models/jersey_barrier/model.sdf";
    const unparsed = [
      "plugin:ignition::gazebo::systems::JointController",
      "joint:chassis",
      "actor:walker",
      "light:lamp",
    ];
    const compiled = {
      schema: "xgc2.scene.compiled.v1",
      id: "yard",
      frame: "world",
      ground: { mode: "default_plane", z: 0 },
      geometries: [mesh],
      models: {
        jersey: {
          parts: [
            {
              id: "base_link_collision",
              pose,
              geometryIndex: 0,
              color: [1, 0.5, 0.1, 1],
            },
          ],
          resource: { format: "sdformat-model", file },
          unparsed,
        },
      },
      obstacles: [
        { id: "barrier-1", name: "North", model: "jersey", pose, motion: { type: "hold" } },
      ],
    };
    const parsed = parseSceneEnvelope(
      envelope(
        source({
          models: {
            jersey: {
              name: "Jersey barrier",
              resource: { format: "sdformat-model", file: "models/jersey_barrier/model.sdf" },
            },
          },
          obstacles: [
            { id: "barrier-1", name: "North", pose, motion: { type: "hold" }, model: "jersey" },
          ],
        }),
        compiled,
      ),
    );
    expect(parsed.compiled?.models.jersey?.resource).toEqual({ format: "sdformat-model", file });
    expect(parsed.compiled?.models.jersey?.unparsed).toEqual(unparsed);
    expect(parsed.document.models?.jersey).not.toHaveProperty("unparsed");
    const table = new SceneGeometryTable(parsed.compiled!.geometries);
    expect(table.shared(0).getAttribute("position").count).toBe(3);
    expect(parsed.compiled?.models.jersey?.unparsed).toEqual(unparsed);
    table.dispose();
    for (const notes of [["plugin", 1], "plugin:controller", { "0": "plugin" }] as const) {
      expect(() =>
        parseSceneEnvelope(
          envelope(source({ obstacles: [] }), {
            ...compiled,
            models: { jersey: { ...compiled.models.jersey, unparsed: notes } },
            obstacles: [],
          }),
        ),
      ).toThrow("Invalid compiled model");
    }
    expect(() =>
      parseSceneEnvelope(
        envelope(source({ obstacles: [] }), {
          ...compiled,
          models: { jersey: { ...compiled.models.jersey, notes: ["plugin"] } },
          obstacles: [],
        }),
      ),
    ).toThrow("Invalid compiled model");
    expect(() =>
      parseSceneEnvelope(
        envelope(
          source({
            models: {
              jersey: {
                name: "Jersey barrier",
                resource: { format: "sdformat-model", file: "models/jersey_barrier/model.sdf" },
                unparsed,
              },
            },
            obstacles: [],
          }),
        ),
      ),
    ).toThrow("analytic parts or one resource");
  });

  it("shares definition buffers, derives one image buffer per part, and disposes the table once", () => {
    const shape: SceneGeometry = { type: "box", size: [1, 1, 1] };
    const table = new SceneGeometryTable([shape]);
    const draft = new SceneGeometryTable([shape]);
    expect(table.shared(0)).toBe(table.shared(0));
    const derived = table.imagePart("jersey:collision", 0, []);
    expect(table.imagePart("jersey:collision", 0, [])).toBe(derived);
    expect(derived).not.toBe(table.shared(0));
    const sharedDispose = jest.spyOn(table.shared(0), "dispose");
    const draftGeometry = draft.shared(0);
    draft.dispose();
    expect(draftGeometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(table.shared(0).getAttribute("position").count).toBeGreaterThan(0);
    table.dispose();
    expect(sharedDispose).toHaveBeenCalledTimes(1);
    table.dispose();
    expect(sharedDispose).toHaveBeenCalledTimes(1);
    const authored = authoredObstacle({
      id: "barrier-1",
      name: "North",
      pose,
      motion: { type: "hold" },
      model: "jersey",
    });
    expect(authored).toMatchObject({ model: "jersey" });
    expect(authored).not.toHaveProperty("parts");
    expect(JSON.stringify(authored)).not.toContain("parts");
  });
});
