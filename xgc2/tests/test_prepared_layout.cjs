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
    // Frozen expected bytes include the current description transport.
    assert.equal(createHash("sha256").update(JSON.stringify(value.layout)).digest("hex"), f.layoutSha256);
    assert.deepEqual(f.input, before, "frozen facts are unchanged");
    assert.equal(Object.hasOwn(value, "allowedTopics"), false);
    assert.equal(Object.hasOwn(value, "displayRelays"), false);
  });

test("reference grids stay in world coordinates when a robot is followed", () => {
  let grids = 0;
  for (const fixture of fixtures) {
    const { layout } = prepareLayout(mapViewInput(fixture.input));
    for (const config of Object.values(layout.configById)) {
      const grid = config.layers?.["xgc2-grid"];
      if (!grid) continue;
      grids++;
      assert.equal(grid.frameId, "world", fixture.name);
    }
  }
  assert.ok(grids > 0);
});

test("robot models consume latched descriptions for every robot kind and view", () => {
  const kinds = new Set();
  for (const fixture of fixtures) {
    const { layout } = prepareLayout(mapViewInput(fixture.input));
    for (const config of Object.values(layout.configById)) {
      for (const layer of Object.values(config.layers ?? {})) {
        if (layer.layerId !== "foxglove.Urdf") continue;
        const robot = fixture.input.robots.find((r) => r.namespace === `/${layer.label}`);
        kinds.add(robot.kind);
        assert.equal(layer.sourceType, "topic");
        assert.equal(layer.topic, `${robot.namespace}/visual_robot_description`);
        assert.equal(Object.hasOwn(layer, "parameter"), false);
      }
    }
  }
  assert.ok(kinds.has("px4_multirotor") && kinds.has("scout_mini") && kinds.has("mecanum_ugv"));
});

test("RobotFact maps binding and asset fields and derives the slot name from its namespace", () => {
  const fact = structuredClone(fixtures[0].input.robots[0]);
  fact.binding.scout = { lidarSimulationEnabled: false, imageSimulationEnabled: true };
  assert.deepEqual(mapRobotFact(fact), {
    slotId: fact.slotId, namespace: fact.namespace, kind: fact.kind, name: "uav1",
    initialPose: fact.binding.initialPose, hybridSource: fact.binding.hybridSource,
    authoredSimulationSensors: fact.binding.simulationSensors, scout: fact.binding.scout,
    visualization: fact.derived.visualization,
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
    (r) => delete r.derived.visualization,
    (r) => delete r.derived.visualization.visuals,
    (r) => (r.namespace = "invalid"),
    (r) => (r.derived.visualization.pathTopic = "invalid topic"),
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

test("accepts Marker and MarkerArray display copies without inventing pose axes", () => {
  const colliding = structuredClone(fixtures[1].input);
  colliding.visualizationTopics[0].topic = "/xgc/scene";
  assert.throws(() => prepareLayout(mapViewInput(colliding)));
  const source = fixtures[1].input.visualizationTopics[0].topic;
  for (const messageType of ["visualization_msgs/Marker", "visualization_msgs/MarkerArray"]) {
    const input = structuredClone(fixtures[1].input);
    input.visualizationTopics[0].messageType = messageType;
    input.visualizationTopics[0].maxRateHz = 10;
    input.visualizationTopics[0].showPoseAxes = true;
    const topics = prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"].topics;
    const settings = topics[`/xgc/display${source}`];
    assert.deepEqual(settings, { visible: true });
    assert.equal(topics[source], undefined);
  }
});

test("history parameters keep the author path style and record the send ceiling", () => {
  const input = structuredClone(fixtures[0].input);
  const base = prepareLayout(mapViewInput(input));
  assert.equal(base.parameters.historyMaxRateHz, 2);
  assert.equal(base.parameters.historyVisible, true);
  assert.equal(base.parameters.historyShowPoseAxes, false);
  assert.deepEqual(base.layout.configById["3D!xgc2"].topics["/uav1/path"], {
    visible: true, type: "line", lineWidth: 0.02, gradient: ["#f2003c80", "#f2003cff"],
  });
  input.robots[0].derived.visualization.pathLineWidthMeters = 0.05;
  input.parameters = { historyMaxRateHz: 5, historyShowPoseAxes: true };
  const shown = prepareLayout(mapViewInput(input));
  assert.equal(shown.parameters.historyMaxRateHz, 5);
  assert.deepEqual(shown.layout.configById["3D!xgc2"].topics["/uav1/path"], {
    visible: true, type: "line-axes", lineWidth: 0.05, axisScale: 0.15, gradient: ["#f2003c80", "#f2003cff"],
  });
  assert.equal(shown.layout.configById["3D!xgc2"].topics["/xgc/display/uav1/path"], undefined);
  input.parameters = { historyVisible: false };
  assert.equal(prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"].topics["/uav1/path"], undefined);
  input.parameters = { historyMaxRateHz: 0 };
  assert.throws(() => prepareLayout(mapViewInput(input)), /historyMaxRateHz/);
});

test("robotNamespace selects that robot palette and explicit color still wins", () => {
  const palette = ["#1d6cd4", "#ffaa00", "#aaaa00", "#aa00ff", "#00aa00", "#ff0000", "#be7879"];
  const input = structuredClone(fixtures[0].input);
  input.layoutMode = "3d";
  delete input.camera;
  input.parameters = { uavPalette: palette, gridColor: "#9e9e9e" };
  const seed = input.robots[0];
  input.robots = palette.map((_, index) => {
    const robot = structuredClone(seed);
    const slot = index + 1;
    robot.slotId = `uav${slot}`;
    robot.namespace = `/uav${slot}`;
    robot.name = `Fixture uav${slot}`;
    return robot;
  });
  const scout = structuredClone(seed);
  scout.slotId = "ugv1";
  scout.namespace = "/ugv1";
  scout.kind = "scout_mini";
  scout.name = "Fixture ugv1";
  input.robots.push(scout);
  const declared = (topic, messageType, role, extra) => ({
    topic, messageType, role, expectedFrame: "world", visible3d: true, visibleAr: false, ...extra,
  });
  input.visualizationTopics = [
    declared("/venue/reference_cloud", "sensor_msgs/PointCloud2", "semantic", { color: "#2196f3e6" }),
    declared("/venue/uncolored_cloud", "sensor_msgs/PointCloud2", "semantic", {}),
    declared("/drone_9/grid", "sensor_msgs/PointCloud2", "obstacle", { paletteAlpha: "ff", pointSize: 0.1, pointSizeMode: "world", pointShape: "square" }),
    ...palette.map((_, index) => declared(`/drone_${index}/grid`, "sensor_msgs/PointCloud2", "obstacle", {
      robotNamespace: `/uav${index + 1}`, paletteAlpha: "b3", pointSize: 0.1, pointSizeMode: "world", pointShape: "square",
    })),
    declared("/drone_0/grid_explicit", "sensor_msgs/PointCloud2", "obstacle", {
      robotNamespace: "/uav1", paletteAlpha: "ff", color: "#ff550099", pointSize: 0.1, pointSizeMode: "world", pointShape: "square",
    }),
    declared("/drone_2/plan", "nav_msgs/Path", "prediction", { robotNamespace: "/uav3", lineWidth: 0.07, paletteAlpha: "ee" }),
    declared("/drone_2/poses", "geometry_msgs/PoseArray", "prediction", { robotNamespace: "/uav3", paletteAlpha: "ee" }),
    declared("/drone_2/poses_plain", "geometry_msgs/PoseArray", "prediction", { robotNamespace: "/uav3", showPoseAxes: false }),
    declared("/drone_2/markers", "visualization_msgs/Marker", "prediction", { robotNamespace: "/uav3", showPoseAxes: true, lineWidth: 0.04 }),
    declared("/drone_2/controls", "visualization_msgs/Marker", "semantic", { robotNamespace: "/uav3", showPoseAxes: true }),
    declared("/drone_2/grid_occ", "nav_msgs/OccupancyGrid", "obstacle", { robotNamespace: "/uav3" }),
    declared("/ugv1/scan", "sensor_msgs/PointCloud2", "obstacle", { robotNamespace: "/ugv1", paletteAlpha: "ff" }),
    declared("/hidden/grid", "sensor_msgs/PointCloud2", "obstacle", { robotNamespace: "/uav1", visible3d: false }),
  ];
  const topics = prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"].topics;
  assert.equal(topics["/venue/reference_cloud"].flatColor, "#2196f3e6");
  assert.equal(topics["/venue/uncolored_cloud"].flatColor, "#8f8f8f99");
  assert.equal(topics["/drone_9/grid"].flatColor, "#3399ffb3");
  palette.forEach((color, index) => {
    const cloud = topics[`/drone_${index}/grid`];
    assert.equal(cloud.flatColor, `${color}b3`);
    assert.equal(cloud.pointSize, 0.1);
    assert.equal(cloud.pointSizeMode, "world");
    assert.equal(cloud.pointShape, "square");
    assert.deepEqual(topics[`/uav${index + 1}/path`].gradient, [`${color}80`, `${color}ff`]);
  });
  assert.equal(topics["/drone_0/grid_explicit"].flatColor, "#ff550099");
  assert.equal(topics["/drone_2/plan"], undefined);
  assert.deepEqual(topics["/xgc/display/drone_2/plan"], {
    visible: true, type: "line-axes", lineWidth: 0.07, axisScale: 0.15,
    gradient: ["#aaaa0080", "#aaaa00ee"],
  });
  assert.deepEqual(topics["/xgc/display/drone_2/poses"], {
    visible: true, type: "arrow", gradient: ["#aaaa0080", "#aaaa00ee"],
  });
  assert.equal(topics["/xgc/display/drone_2/poses_plain"].type, "line");
  assert.equal(topics["/drone_2/markers"], undefined);
  assert.deepEqual(topics["/xgc/display/drone_2/markers"], {
    visible: true, color: "#aaaa00ff", lineWidth: 0.04, showPoints: true, showOutlines: false,
  });
  assert.deepEqual(topics["/drone_2/controls"], { visible: true });
  assert.deepEqual(topics["/drone_2/grid_occ"], { visible: true });
  assert.equal(topics["/ugv1/scan"].flatColor, "#cbab01ff");
  assert.equal(topics["/hidden/grid"].visible, true);
  assert.equal(topics["/hidden/grid"].flatColor, "#1d6cd4ff");
  assert.equal(prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"].layers["xgc2-grid"].color, "#9e9e9e");
  input.visualizationTopics[0].robotNamespace = "/missing";
  assert.throws(() => prepareLayout(mapViewInput(input)), /robot namespace/);
  input.visualizationTopics[0].robotNamespace = "/uav1";
  input.visualizationTopics[0].paletteAlpha = "xyz";
  assert.throws(() => prepareLayout(mapViewInput(input)), /palette alpha/);
});

test("obstacle projection stays in 3D and physical augmented views keep the tint", () => {
  const input = structuredClone(fixtures.find((fixture) => fixture.name === "physical-usb-camera").input);
  const layout = prepareLayout(mapViewInput(input)).layout;
  assert.equal(input.visualizationTopics.find((topic) => topic.topic === "/venue/obstacles").visibleAr, false);
  assert.equal(layout.configById["3D!xgc2"].topics["/venue/obstacles"].flatColor, "#3399ffb3");
  assert.equal(layout.configById["3D!xgc2"].topics["/venue/obstacles"].color, undefined);
  const augmented = layout.configById["Image!xgc2-camera-ar"].topics["/venue/obstacles"];
  assert.equal(augmented.color, "#ff801a66");
  assert.equal(augmented.flatColor, "#3399ffb3");
  assert.equal(layout.configById["3D!xgc2"].topics["/robot_0/plan"], undefined);
  assert.equal(layout.configById["Image!xgc2-camera-ar"].topics["/xgc/display/robot_0/plan"].type, "line-axes");
});

test("prediction display copies ignore a missing maxRateHz and explicit pose axes win", () => {
  const input = structuredClone(fixtures[1].input);
  for (const topic of input.visualizationTopics) delete topic.maxRateHz;
  const prepared = prepareLayout(mapViewInput(input));
  assert.equal(prepared.parameters.predictionMaxRateHz, 2);
  assert.equal(prepared.parameters.predictionShowPoseAxes, true);
  const topics = prepared.layout.configById["3D!xgc2"].topics;
  for (const topic of input.visualizationTopics) {
    if (topic.role !== "prediction" || !topic.visible3d) continue;
    const settings = topics[`/xgc/display${topic.topic}`];
    assert.ok(settings, topic.topic);
    assert.equal(topics[topic.topic], undefined, topic.topic);
    if (topic.messageType.startsWith("visualization_msgs/")) {
      assert.equal(settings.type, undefined, topic.topic);
      assert.equal(settings.axisScale, undefined, topic.topic);
    }
  }
  assert.ok(topics["/robot_0/private_map"]);
  assert.equal(topics["/xgc/display/robot_0/private_map"], undefined);
  input.parameters = { predictionShowPoseAxes: false };
  const hiddenAxes = prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"].topics["/xgc/display/robot_0/plan"];
  assert.equal(hiddenAxes.type, "line");
  assert.equal(hiddenAxes.axisScale, undefined);
  input.visualizationTopics.find((topic) => topic.topic === "/robot_0/plan").showPoseAxes = true;
  const explicit = prepareLayout(mapViewInput(input)).layout.configById["3D!xgc2"].topics["/xgc/display/robot_0/plan"];
  assert.equal(explicit.type, "line-axes");
  assert.equal(explicit.axisScale, 0.15);
  input.parameters = { predictionMaxRateHz: 0 };
  assert.throws(() => prepareLayout(mapViewInput(input)), /predictionMaxRateHz/);
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
