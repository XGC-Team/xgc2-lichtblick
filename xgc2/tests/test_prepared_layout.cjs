// SPDX-License-Identifier: MPL-2.0
"use strict";
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { VIEWER_DEFAULTS, mapRobotFact, mapViewInput, prepareLayout } = require("../launcher/prepare-layout.cjs");
const fixtures = require("../launcher/testdata/frozen-layouts.json");

for (const f of fixtures)
  test(`preserves the layout bytes of ${f.name}`, () => {
    const before = structuredClone(f.input);
    const value = prepareLayout(mapViewInput(f.input));
    assert.deepEqual(value.layout, f.layout);
    // Captured from the legacy builder before translating the fixture inputs.
    assert.equal(createHash("sha256").update(JSON.stringify(value.layout)).digest("hex"), f.layoutSha256);
    assert.deepEqual(f.input, before, "frozen facts are unchanged");
    assert.equal(Object.hasOwn(value, "allowedTopics"), false);
    assert.equal(Object.hasOwn(value, "displayRelays"), false);
  });

test("RobotFact maps binding and asset fields and derives the slot name from its namespace", () => {
  const fact = structuredClone(fixtures[0].input.robots[0]);
  fact.binding.scout = { lidarSimulationEnabled: false, imageSimulationEnabled: true };
  assert.deepEqual(mapRobotFact(fact), {
    slotId: fact.slotId, namespace: fact.namespace, kind: fact.kind, name: "uav1",
    initialPose: fact.binding.initialPose, hybridSource: fact.binding.hybridSource,
    authoredSimulationSensors: fact.binding.simulationSensors, scout: fact.binding.scout,
    visualization: fact.asset.visualization,
  });
  assert.notEqual(fact.name, "uav1", "asset display name is not the ROS identity");
});

test("viewer defaults apply once and parameters override them without replacing Run facts", () => {
  const input = structuredClone(fixtures[0].input);
  delete input.parameters;
  const mapped = mapViewInput(input);
  for (const [key, value] of Object.entries(VIEWER_DEFAULTS)) assert.deepEqual(mapped.parameters[key], value, key);
  input.parameters = { gridSize: 41, markerBackgroundVisible: true, px4ModelScale: 3 };
  const prepared = prepareLayout(mapViewInput(input));
  assert.equal(prepared.layout.configById["3D!xgc2"].layers["xgc2-grid"].size, 41);
  assert.equal(prepared.layout.configById["3D!xgc2"].layers["xgc2-urdf-uav1"].scale, 3);
  assert.equal(prepared.layout.configById["3D!xgc2"].topics["/xgc/scene"].showBackground, true);
  for (const key of ["runMode", "layoutMode", "worldBoundary", "cameraImageTopic", "visualizationTopics"])
    assert.throws(() => mapViewInput({ ...input, parameters: { [key]: "override" } }), new RegExp(key));
});

test("3D only needs no camera, while every camera layout needs distinct explicit topics", () => {
  const input = structuredClone(fixtures[0].input);
  input.layoutMode = "3d";
  delete input.camera;
  assert.equal(prepareLayout(mapViewInput(input)).layout.layout, "3D!xgc2");
  for (const layoutMode of ["3d-camera-ar", "camera-ar-3d", "3d-above-camera-ar", "camera-ar-above-3d", "3d-above-camera-ar-plot"])
    assert.throws(() => mapViewInput({ ...input, layoutMode }), /camera required/);
  for (const camera of [null, {}, { imageTopic: "/camera", infoTopic: "/camera" }, { imageTopic: "relative", infoTopic: "/info" }])
    assert.throws(() => mapViewInput({ ...input, camera }), /camera/);
});

test("the stdin contract refuses unknown members and malformed or absent facts", () => {
  const input = structuredClone(fixtures[0].input);
  assert.throws(() => mapViewInput({ ...input, startupInputPath: "x", layoutJson: "x" }), /startupInputPath, layoutJson/);
  for (const value of [null, [], "view"]) assert.throws(() => mapViewInput(value), /one JSON object/);
  for (const key of ["layoutMode", "runMode", "visualizationTopics", "robots"]) {
    const value = structuredClone(input); delete value[key];
    assert.throws(() => mapViewInput(value), new RegExp(key));
  }
  for (const edit of [
    (v) => (v.runMode = "other"),
    (v) => (v.layoutMode = "other"),
    (v) => (v.worldBoundary = []),
    (v) => (v.parameters = null),
    (v) => (v.visualizationTopics = {}),
    (v) => (v.parameters.gridDivisions = 1.5),
  ]) {
    const value = structuredClone(input); edit(value);
    assert.throws(() => prepareLayout(mapViewInput(value)));
  }
});

test("missing or invalid robot layout facts name the offending slot", () => {
  for (const edit of [
    (r) => delete r.binding,
    (r) => delete r.binding.initialPose,
    (r) => (r.binding.initialPose.x = "bad"),
    (r) => delete r.binding.hybridSource,
    (r) => (r.binding.simulationSensors = 3),
    (r) => delete r.asset.visualization,
    (r) => delete r.asset.visualization.visuals,
    (r) => (r.namespace = "invalid"),
    (r) => (r.asset.visualization.pathTopic = "invalid topic"),
  ]) {
    const input = structuredClone(fixtures[0].input); edit(input.robots[0]);
    assert.throws(() => prepareLayout(mapViewInput(input)), /robot slot uav1:/);
  }
  const input = structuredClone(fixtures[0].input);
  input.robots.push(input.robots[0]);
  assert.throws(() => mapViewInput(input), /robot slot uav1: duplicate slotId/);
});

test("an absent simulationSensors member is the empty authored selection", () => {
  const withEmpty = structuredClone(fixtures[0].input);
  for (const robot of withEmpty.robots) robot.binding.simulationSensors = {};
  const absent = structuredClone(withEmpty);
  for (const robot of absent.robots) delete robot.binding.simulationSensors;
  assert.deepEqual(prepareLayout(mapViewInput(absent)), prepareLayout(mapViewInput(withEmpty)));
});

test("display budgets select display copies in the layout and Plot keeps scientific sources", () => {
  const input = structuredClone(fixtures[1].input);
  input.visualizationTopics[0].maxRateHz = 1;
  input.parameters.plotPaths = ["/venue/reference_cloud.width"];
  input.layoutMode = "3d-above-camera-ar-plot";
  const { layout } = prepareLayout(mapViewInput(input));
  assert(layout.configById["3D!xgc2"].topics["/xgc/display/venue/reference_cloud"]);
  assert.equal(layout.configById["Plot!xgc2-plot"].paths[0].value, "/venue/reference_cloud.width");
});

test("rejects colliding or incremental relay declarations", () => {
  for (const edit of [
    (v) => (v.visualizationTopics[0].topic = "/xgc/scene"),
    (v) => { v.visualizationTopics[0].messageType = "visualization_msgs/MarkerArray"; v.visualizationTopics[0].maxRateHz = 1; },
  ]) {
    const input = structuredClone(fixtures[1].input); edit(input);
    assert.throws(() => prepareLayout(mapViewInput(input)));
  }
});

test("the frozen world boundary participates in camera framing when requested", () => {
  const input = structuredClone(fixtures[0].input);
  input.parameters = { frameWorldBoundary: true };
  input.worldBoundary = { controlBounds: { xMin: -100, xMax: 100, yMin: 20, yMax: 60, zMin: 0, zMax: 30 }, groundZ: 2 };
  const three = prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"];
  assert.deepEqual(three.layers["xgc2-grid"].position, [0, 40, 2]);
  assert.ok(three.cameraState.distance > 100, "the camera includes the large boundary, not just one robot");
  input.worldBoundary = null;
  assert.deepEqual(prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"].layers["xgc2-grid"].position, [0, 0, 0]);
});

test("stdin is one JSON object of at most 8 MiB", () => {
  const program = path.resolve(__dirname, "../launcher/prepare-layout.cjs");
  const json = JSON.stringify(fixtures[0].input);
  const run = (input) => spawnSync(process.execPath, [program], { input, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000 });
  const exact = run(json + " ".repeat(8 * 1024 * 1024 - Buffer.byteLength(json)));
  assert.equal(exact.status, 0, exact.stderr);
  assert.deepEqual(JSON.parse(exact.stdout).layout, fixtures[0].layout);
  const oversized = run(json + " ".repeat(8 * 1024 * 1024 + 1 - Buffer.byteLength(json)));
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /view input exceeds 8 MiB/);
  for (const input of ["", "[]", json + json, "{"])
    assert.notEqual(run(input).status, 0, input.slice(0, 30));
});
