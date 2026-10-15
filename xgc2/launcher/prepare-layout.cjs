// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

// Pure viewer preparation. The caller supplies frozen membership and explicit
// camera topics; neither the workflow host nor this module discovers a world.
const assert = require("node:assert/strict");

const palettes = {
  px4_multirotor: [
    "#f2003c",
    "#ff7043",
    "#ab47bc",
    "#ec407a",
    "#7e57c2",
    "#ef5350",
    "#ffa726",
    "#d4e157",
  ],
  scout_mini: [
    "#cbab01",
    "#8bc34a",
    "#ffca28",
    "#66bb6a",
    "#c0ca33",
    "#26a69a",
    "#d4a373",
    "#a1887f",
  ],
  mecanum_ugv: [
    "#288f8c",
    "#29b6f6",
    "#5c6bc0",
    "#26c6da",
    "#42a5f5",
    "#7e57c2",
    "#80cbc4",
    "#90caf9",
  ],
};
// Viewer defaults formerly supplied by Core's Lichtblick provisioning. Keep the
// complete table here; Run facts and camera topics have no defaults.
const VIEWER_DEFAULTS = Object.freeze({
  gridVisible: true,
  gridColor: "#9e9e9e",
  gridSize: 30,
  gridDivisions: 30,
  gridLineWidth: 1,
  axesVisible: true,
  axesScale: 1,
  scoutModelScale: 1,
  px4ModelScale: 2,
  mecanumModelScale: 1,
  worldBoundaryMode: "walls",
  uavHeightProjection: true,
  predictionLineWidth: 0.04,
  predictionAxisScale: 0.15,
  markerColor: "#00a2ff",
  markerBackgroundColor: "#000000",
  markerBackgroundVisible: false,
  labelScaleInvariant: false,
  labelFontSizeMeters: 0.24,
  labelFontSizePixels: 16,
  markerOpacity: 1,
  uavLabelOffset: 0.55,
  scoutLabelOffset: 0.65,
  mecanumLabelOffset: 0.32,
  uavPalette: palettes.px4_multirotor,
  scoutPalette: palettes.scout_mini,
  mecanumPalette: palettes.mecanum_ugv,
  sceneNamespace: "",
  obstacleSceneVisible: true,
  transformTopics: [],
  plotPaths: [],
  simpleLidarVisible: false,
  simpleLidarMaxRateHz: 0,
  simpleLidarMaxMessageBytes: 0,
  frameWorldBoundary: false,
  historyMaxRateHz: 2,
  historyLineWidth: 0.04,
  historyVisible: true,
  historyShowPoseAxes: false,
  predictionShowPoseAxes: false,
  predictionMaxRateHz: 2,
});
const topicPattern = /^\/[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/;
const colorPattern = /^#[0-9a-fA-F]{6}$/;
const relayTypes = new Set([
  "sensor_msgs/PointCloud2",
  "nav_msgs/OccupancyGrid",
  "nav_msgs/Path",
  "geometry_msgs/PoseArray",
  "visualization_msgs/Marker",
  "visualization_msgs/MarkerArray",
]);
const messageTypes = new Set(relayTypes);
const array = (value) => Array.isArray(value);
const topic = (value) =>
  typeof value === "string" && value.length <= 511 && topicPattern.test(value);
const within = (value, low, high) =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const namespaced = (robot, relative) => (relative ? `${robot.namespace}/${relative}` : "");
const model = (robot) => robot.visualization.sceneModel || robot.name;
const frame = (robot) =>
  robot.visualization.sceneClass ? `xgc/robots/${model(robot)}` : model(robot);
const display = (declared) =>
  declared.role === "prediction" || declared.maxRateHz > 0
    ? `/xgc/display${declared.topic}`
    : declared.topic;
const visible = (value = true) => ({ visible: value });
const overlay = (value) => ({ visible: value, showOutlines: false });
const slot = (name) => Number(/\d+$/.exec(name)?.[0] ?? 0);
const object = (value) => value != null && typeof value === "object" && !array(value);

/** Projects Core's frozen RobotFact without changing its binding or asset. */
function mapRobotFact(fact) {
  const identity = fact?.slotId ?? "(missing slotId)";
  const check = (condition, message) => assert(condition, `robot slot ${identity}: ${message}`);
  check(
    object(fact) && typeof fact.slotId === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(fact.slotId),
    "valid slotId required",
  );
  check(object(fact.binding), "binding required");
  check(object(fact.binding.initialPose), "binding.initialPose required");
  // Core omits a zero-valued simulationSensors member: absent means no authored sensors.
  check(
    Object.is(fact.binding.simulationSensors, undefined) || object(fact.binding.simulationSensors),
    "binding.simulationSensors must be an object",
  );
  check(
    Object.is(fact.binding.scout, undefined) || object(fact.binding.scout),
    "binding.scout must be an object",
  );
  check(
    object(fact.derived) && object(fact.derived.visualization),
    "derived.visualization required",
  );
  return {
    slotId: fact.slotId,
    namespace: fact.namespace,
    kind: fact.kind,
    // The layout uses the slot namespace, not the asset's human-readable name.
    name: typeof fact.namespace === "string" ? fact.namespace.slice(1) : undefined,
    initialPose: fact.binding.initialPose,
    hybridSource: fact.binding.hybridSource,
    authoredSimulationSensors: fact.binding.simulationSensors ?? {},
    scout: fact.binding.scout,
    visualization: fact.derived.visualization,
  };
}

/** Maps the single high-level stdin document to prepareLayout's pure input. */
function mapViewInput(input) {
  assert(object(input), "view input must be one JSON object");
  const allowed = [
    "layoutMode",
    "runMode",
    "worldBoundary",
    "camera",
    "visualizationTopics",
    "robots",
    "parameters",
  ];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  assert(unknown.length === 0, `unknown view input members: ${unknown.join(", ")}`);
  for (const key of ["layoutMode", "runMode", "visualizationTopics", "robots"]) {
    assert(Object.hasOwn(input, key), `missing view input member ${key}`);
  }
  assert(
    input.worldBoundary == null || object(input.worldBoundary),
    "worldBoundary must be an object or null",
  );
  assert(array(input.robots), "robots must be an array of frozen RobotFact rows");
  assert(
    Object.is(input.parameters, undefined) || object(input.parameters),
    "parameters must be an object",
  );
  for (const key of Object.keys(input.parameters ?? {})) {
    assert(Object.hasOwn(VIEWER_DEFAULTS, key), `unknown viewer parameter ${key}`);
  }
  if (!Object.is(input.camera, undefined)) {
    assert(object(input.camera), "camera must be an object");
    for (const key of Object.keys(input.camera)) {
      assert(["imageTopic", "infoTopic"].includes(key), `unknown camera member ${key}`);
    }
    assert(
      topic(input.camera.imageTopic) &&
        topic(input.camera.infoTopic) &&
        input.camera.imageTopic !== input.camera.infoTopic,
      "distinct explicit camera topics required",
    );
  }
  assert(
    input.layoutMode === "3d" || !Object.is(input.camera, undefined),
    "camera required for a layout containing a camera panel",
  );
  const robots = input.robots.map(mapRobotFact);
  const slots = new Set();
  const namespaces = new Set();
  for (const robot of robots) {
    assert(!slots.has(robot.slotId), `robot slot ${robot.slotId}: duplicate slotId`);
    assert(
      !namespaces.has(robot.namespace),
      `robot slot ${robot.slotId}: duplicate namespace ${robot.namespace}`,
    );
    slots.add(robot.slotId);
    namespaces.add(robot.namespace);
  }
  return {
    parameters: {
      ...structuredClone(VIEWER_DEFAULTS),
      ...input.parameters,
      layoutMode: input.layoutMode,
      visualizationTopics: input.visualizationTopics,
    },
    context: { runMode: input.runMode, worldBoundary: input.worldBoundary },
    camera: input.camera,
    robots,
  };
}

function prepareLayout(input) {
  assert(
    input && typeof input === "object" && input.parameters && array(input.robots),
    "explicit parameters and frozen robots required",
  );
  assert(input.robots.length <= 256, "at most 256 robots");
  const p = {
    ...VIEWER_DEFAULTS,
    ...input.parameters,
  };
  if (input.camera) {
    p.cameraImageTopic = input.camera.imageTopic;
    p.cameraInfoTopic = input.camera.infoTopic;
  }
  if (input.context) {
    p.runMode = input.context.runMode;
    p.worldBoundary = input.context.worldBoundary;
  }
  assert(["simulation", "physical", "hybrid"].includes(p.runMode), "explicit runMode required");
  assert(
    [
      "3d",
      "3d-camera-ar",
      "camera-ar-3d",
      "3d-above-camera-ar",
      "camera-ar-above-3d",
      "3d-above-camera-ar-plot",
    ].includes(p.layoutMode),
    "invalid layoutMode",
  );
  if (
    p.layoutMode !== "3d" ||
    !Object.is(p.cameraImageTopic, undefined) ||
    !Object.is(p.cameraInfoTopic, undefined)
  ) {
    assert(
      topic(p.cameraImageTopic) &&
        topic(p.cameraInfoTopic) &&
        p.cameraImageTopic !== p.cameraInfoTopic,
      "distinct explicit camera topics required",
    );
  }
  assert(
    !p.sceneNamespace || (topic(p.sceneNamespace) && p.sceneNamespace.length <= 160),
    "invalid scene namespace",
  );
  for (const [key, low, high] of [
    ["gridSize", 0.1, 100000],
    ["gridDivisions", 1, 10000],
    ["gridLineWidth", 0.1, 100],
    ["axesScale", 0.01, 100000],
    ["scoutModelScale", 0.1, 20],
    ["px4ModelScale", 0.1, 20],
    ["mecanumModelScale", 0.1, 20],
    ["predictionLineWidth", 0.001, 1],
    ["historyLineWidth", 0.001, 1],
    ["predictionAxisScale", 0.01, 10],
  ]) {
    assert(within(p[key], low, high), `invalid ${key}`);
  }
  assert(Number.isInteger(p.gridDivisions), "integer gridDivisions required");
  for (const key of [
    "gridVisible",
    "obstacleSceneVisible",
    "simpleLidarVisible",
    "axesVisible",
    "uavHeightProjection",
    "markerBackgroundVisible",
    "frameWorldBoundary",
    "historyVisible",
    "historyShowPoseAxes",
    "predictionShowPoseAxes",
  ]) {
    assert(typeof p[key] === "boolean", `invalid ${key}`);
  }
  assert(within(p.historyMaxRateHz, 0.1, 100), "invalid historyMaxRateHz");
  assert(within(p.predictionMaxRateHz, 0.1, 100), "invalid predictionMaxRateHz");
  assert(["off", "ground", "walls"].includes(p.worldBoundaryMode), "invalid worldBoundaryMode");
  for (const key of ["gridColor", "markerBackgroundColor"]) {
    assert(colorPattern.test(p[key]), `invalid ${key}`);
    p[key] = p[key].toLowerCase();
  }
  for (const key of ["uavPalette", "scoutPalette", "mecanumPalette"]) {
    if (p[key] != null) {
      assert(
        array(p[key]) &&
          p[key].length >= 1 &&
          p[key].length <= 32 &&
          p[key].every((c) => colorPattern.test(c)),
        `invalid ${key}`,
      );
    }
  }
  assert(
    array(p.visualizationTopics) &&
      p.visualizationTopics.length <= 64 &&
      array(p.transformTopics) &&
      p.transformTopics.length <= 4,
    "explicit bounded topic declarations required",
  );
  assert(array(p.plotPaths) && p.plotPaths.length <= 16, "invalid plotPaths");
  const checkRate = (rate, bytes) =>
    assert(
      (rate === 0 && bytes === 0) ||
        (within(rate, 0.1, 100) && Number.isSafeInteger(bytes) && bytes >= 0),
      "invalid display budget",
    );
  checkRate(p.simpleLidarMaxRateHz, p.simpleLidarMaxMessageBytes);
  const robots = input.robots.map((raw) => {
    try {
      assert(
        raw &&
          topic(raw.namespace) &&
          /^\/[A-Za-z_][A-Za-z0-9_]*$/.test(raw.namespace) &&
          typeof raw.kind === "string",
        "invalid frozen robot identity",
      );
      const r = {
        ...raw,
        name: raw.namespace.slice(1),
        visualization: { ...raw.visualization },
      };
      assert(
        r.initialPose && ["x", "y", "z", "yaw"].every((k) => Number.isFinite(r.initialPose[k])),
        "finite initial pose required",
      );
      assert(["simulation", "physical"].includes(r.hybridSource), "frozen hybridSource required");
      assert(
        raw.authoredSimulationSensors && typeof raw.authoredSimulationSensors === "object",
        "authoredSimulationSensors required",
      );
      r.simpleLidar = raw.authoredSimulationSensors.simpleLidar?.enabled === true;
      if (r.kind === "scout_mini" && raw.scout) {
        const mocap = (raw.scout.mocapRigidBodyName || "").trim();
        r.visualization.sceneModel =
          mocap && mocap !== r.name && !r.name.startsWith("ugv") ? mocap : "";
      }
      for (const key of ["odometryTopic", "jointStateTopic", "pathTopic"]) {
        if (r.visualization[key]) {
          assert(topic(namespaced(r, r.visualization[key])), "invalid robot topic");
        }
      }
      assert(array(r.visualization.visuals), "frozen visualization visuals required");
      if (r.visualization.initialCameraDistanceMeters != null) {
        assert(
          within(r.visualization.initialCameraDistanceMeters, 0.1, 100000),
          "invalid camera distance",
        );
      }
      if (r.visualization.pathLineWidthMeters != null) {
        assert(within(r.visualization.pathLineWidthMeters, 0.001, 100), "invalid path width");
      }
      return r;
    } catch (error) {
      if (raw?.slotId) {
        error.message = `robot slot ${raw.slotId}: ${error.message}`;
      }
      throw error;
    }
  });
  assert(new Set(robots.map((r) => r.name)).size === robots.length, "duplicate robot identity");
  const source = (r) => (p.runMode === "hybrid" ? r.hybridSource : p.runMode);
  const lidar = robots
    .filter((r) => r.simpleLidar && source(r) === "simulation")
    .map((r) => namespaced(r, "simple_lidar/points"));
  const lidarDisplay = (t) => (p.simpleLidarMaxRateHz > 0 ? `/xgc/display${t}` : t);
  const paletteColor = (robot) => {
    const peers = robots
      .filter((v) => v.kind === robot.kind)
      .sort((a, b) => slot(a.name) - slot(b.name) || a.name.localeCompare(b.name));
    const palette = p[
      robot.kind === "scout_mini"
        ? "scoutPalette"
        : robot.kind === "mecanum_ugv"
          ? "mecanumPalette"
          : "uavPalette"
    ] ||
      palettes[robot.kind] || ["#f2003c"];
    return palette[peers.findIndex((v) => v.name === robot.name) % palette.length].toLowerCase();
  };
  const history = (robot) => {
    if (!p.historyVisible) {
      return undefined;
    }
    const color = paletteColor(robot);
    const axes = p.historyShowPoseAxes;
    const settings = {
      visible: true,
      type: axes ? "line-axes" : "line",
      lineWidth: robot.visualization.pathLineWidthMeters || p.historyLineWidth,
      gradient: [color + "80", color + "ff"],
    };
    if (axes) {
      settings.axisScale = p.predictionAxisScale;
    }
    return settings;
  };
  // AR depicts the simulated roster independently of camera topic names.
  const obstacleProjection = Boolean(p.sceneNamespace);
  const simulatedProjection = p.runMode === "simulation";
  const label = () => ({
    visible: true,
    showOutlines: false,
    showBackground: p.markerBackgroundVisible,
    backgroundColor: p.markerBackgroundColor,
  });
  const topics = (ar) => ({
    [ar ? "/xgc/scene_ar" : "/xgc/scene"]: label(),
    [ar ? "/xgc/world_boundary_ar" : "/xgc/world_boundary"]: overlay(
      p.worldBoundaryMode === "ground",
    ),
    [ar ? "/xgc/world_boundary_walls_ar" : "/xgc/world_boundary_walls"]: overlay(
      p.worldBoundaryMode === "walls",
    ),
    [ar ? "/xgc/uav_height_projection_ar" : "/xgc/uav_height_projection"]: overlay(
      p.uavHeightProjection,
    ),
    "/xgc/tf": visible(),
    "/tf_static": visible(),
    "/xgc/aligned/scene": overlay(false),
  });
  const threeTopics = topics(false),
    arTopics = topics(true);
  const globalTF = robots.some((r) => !r.visualization.sceneClass);
  if (globalTF) {
    threeTopics["/tf"] = visible();
  }
  if (obstacleProjection || simulatedProjection) {
    arTopics["/tf"] = visible();
  }
  for (const r of robots) {
    if (r.visualization.descriptionPackage) {
      threeTopics[`${r.namespace}/visual_robot_description`] = overlay(false);
    }
    if (r.visualization.odometryTopic) {
      threeTopics[namespaced(r, r.visualization.odometryTopic)] = visible();
    }
    const traced = history(r);
    if (traced && r.visualization.pathTopic) {
      threeTopics[namespaced(r, r.visualization.pathTopic)] = traced;
    }
    const arPath = r.visualization.sceneClass === "fs150" ? "ar_path" : r.visualization.pathTopic;
    if (traced && arPath) {
      arTopics[namespaced(r, arPath)] = history(r);
    }
    for (const v of r.visualization.visuals) {
      threeTopics[`${model(r)}/${v.link}-${v.index}-${v.geometryType}`] = {
        showOutlines: false,
      };
    }
  }
  const declaredSettings = (t) => {
    const s = visible();
    const owner = t.robotNamespace
      ? robots.find((r) => r.namespace === t.robotNamespace)
      : undefined;
    const tint = owner ? paletteColor(owner) : undefined;
    const alpha = t.paletteAlpha != null ? String(t.paletteAlpha).toLowerCase() : undefined;
    const flat = (fallback) => (t.color ? t.color : tint ? tint + (alpha || "ff") : fallback);
    const gradient = (fallback) =>
      t.color ? [t.color, t.color] : tint ? [tint + "80", tint + (alpha || "ff")] : fallback;
    if (t.messageType === "sensor_msgs/PointCloud2") {
      Object.assign(s, {
        decayTime: 0,
        pointSize: t.pointSize != null ? t.pointSize : 2,
        pointSizeMode: t.pointSizeMode || "screen",
        pointShape: t.pointShape || (t.role === "obstacle" ? "square" : "circle"),
        colorMode: "flat",
        colorField: "z",
        flatColor: flat(t.role === "obstacle" ? "#3399ffb3" : "#8f8f8f99"),
      });
    }
    const poseAxes = t.role !== "prediction" && t.showPoseAxes === true;
    if (t.messageType === "nav_msgs/Path") {
      Object.assign(s, {
        type: poseAxes ? "line-axes" : "line",
        lineWidth: t.role === "prediction" ? p.predictionLineWidth : 0.04,
        gradient: gradient(
          t.role === "prediction" ? ["#ffbf00ff", "#ffbf0040"] : ["#000000ff", "#00000040"],
        ),
      });
      if (poseAxes) {
        s.axisScale = p.predictionAxisScale;
      }
    }
    if (t.messageType === "geometry_msgs/PoseArray" && t.role === "prediction") {
      Object.assign(s, {
        type: "line",
        gradient: gradient(["#ffbf00ff", "#ffbf0040"]),
      });
    }
    if (
      t.messageType === "visualization_msgs/Marker" ||
      t.messageType === "visualization_msgs/MarkerArray"
    ) {
      if (t.role === "prediction") {
        s.showPoints = false;
        s.showOutlines = false;
        s.lineWidth = p.predictionLineWidth;
      }
      if (t.color || (tint && (t.role === "prediction" || t.role === "obstacle" || alpha))) {
        s.color = t.color || tint + (alpha || "ff");
      }
    }
    for (const k of ["lineWidth", "markerScale"]) {
      if (t[k] != null) {
        s[k] = t[k];
      }
    }
    if (t.color) {
      if (t.messageType === "sensor_msgs/PointCloud2") {
        s.flatColor = t.color;
      }
      if (["nav_msgs/Path", "geometry_msgs/PoseArray"].includes(t.messageType)) {
        s.gradient = [t.color, t.color];
      }
    }
    return s;
  };
  // System topic names remain reserved for declaration collision checks.
  const declaredNames = new Set([
    "/xgc/scene",
    "/xgc/scene_ar",
    "/xgc/world_boundary",
    "/xgc/world_boundary_ar",
    "/xgc/world_boundary_walls",
    "/xgc/world_boundary_walls_ar",
    "/xgc/uav_height_projection",
    "/xgc/uav_height_projection_ar",
    "/xgc/tf",
    "/tf_static",
    "/xgc/aligned/scene",
    "/xgc/aligned/tf",
    "/xgc/aligned/xgc_tf",
    "/xgc/camera/world/tf",
  ]);
  if (p.cameraImageTopic) {
    declaredNames.add(p.cameraImageTopic);
  }
  if (p.cameraInfoTopic) {
    declaredNames.add(p.cameraInfoTopic);
  }
  if (globalTF || p.sceneNamespace) {
    declaredNames.add("/tf");
  }
  if (p.sceneNamespace) {
    for (const suffix of ["snapshot", "state", "document", "markers"]) {
      declaredNames.add(`${p.sceneNamespace}/${suffix}`);
    }
  }
  for (const r of robots) {
    for (const relative of [
      r.visualization.odometryTopic,
      r.visualization.jointStateTopic,
      r.visualization.pathTopic,
    ]) {
      if (relative) {
        declaredNames.add(namespaced(r, relative));
      }
    }
    if (r.visualization.sceneClass === "fs150") {
      declaredNames.add(namespaced(r, "ar_path"));
    }
  }
  for (const t of lidar) {
    declaredNames.add(lidarDisplay(t));
    threeTopics[lidarDisplay(t)] = {
      visible: p.simpleLidarVisible,
      pointSize: 2,
      decayTime: 0,
      colorMode: "colormap",
      colorMap: "turbo",
      colorField: "z",
    };
  }
  for (const t of p.visualizationTopics) {
    assert(
      topic(t.topic) && !t.topic.startsWith("/xgc/display/") && !declaredNames.has(t.topic),
      "invalid or colliding declared topic",
    );
    declaredNames.add(t.topic);
    assert(
      messageTypes.has(t.messageType) && ["prediction", "obstacle", "semantic"].includes(t.role),
      "unsupported visualization declaration",
    );
    assert(
      typeof t.visible3d === "boolean" &&
        typeof t.visibleAr === "boolean" &&
        typeof t.expectedFrame === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(t.expectedFrame),
      "invalid visibility or expected frame",
    );
    checkRate(t.maxRateHz || 0, t.maxMessageBytes || 0);
    if (t.maxRateHz) {
      assert(relayTypes.has(t.messageType), "incremental messages cannot be throttled");
    }
    if (t.lineWidth != null) {
      assert(within(t.lineWidth, 0.0001, 100), "invalid line width");
    }
    if (t.markerScale != null) {
      assert(within(t.markerScale, 0.0001, 100000), "invalid marker scale");
    }
    if (t.color) {
      assert(/^#[0-9a-fA-F]{8}$/.test(t.color), "invalid layer color");
    }
    if (t.pointSize != null) {
      assert(within(t.pointSize, 0.1, 64), "invalid point size");
    }
    if (t.pointShape) {
      assert(["circle", "square"].includes(t.pointShape), "invalid point shape");
    }
    if (t.pointSizeMode) {
      assert(["screen", "world"].includes(t.pointSizeMode), "invalid point size mode");
    }
    if (t.paletteAlpha != null) {
      assert(/^[0-9a-fA-F]{2}$/.test(t.paletteAlpha), "invalid palette alpha");
    }
    if (t.showPoseAxes != null) {
      assert(typeof t.showPoseAxes === "boolean", "invalid showPoseAxes");
    }
    if (t.robotNamespace != null) {
      assert(
        topic(t.robotNamespace) && robots.some((r) => r.namespace === t.robotNamespace),
        "robot namespace is not a roster member",
      );
    }
    if (p.sceneNamespace && t.role === "obstacle") {
      assert(
        !t.messageType.startsWith("visualization_msgs/"),
        "bound scene owns obstacle geometry",
      );
    }
    if (t.visible3d || t.role === "obstacle") {
      threeTopics[display(t)] = declaredSettings(t);
    }
    if (t.role === "obstacle") {
      if (p.runMode !== "simulation") {
        arTopics[display(t)] = { ...declaredSettings(t), color: "#ff801a66" };
      }
    } else if (t.visibleAr) {
      arTopics[display(t)] = declaredSettings(t);
    }
  }
  for (const t of p.transformTopics) {
    assert(topic(t) && !declaredNames.has(t), "invalid or colliding transform topic");
    declaredNames.add(t);
    threeTopics[t] = visible();
    arTopics[t] = visible();
  }
  for (const path of p.plotPaths) {
    assert(
      typeof path === "string" &&
        path.length <= 511 &&
        /^\/[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]+\])?)+$/.test(
          path,
        ),
      "invalid Plot message path",
    );
    assert(!path.startsWith("/xgc/display/"), "Plot reads scientific sources");
  }
  const points = robots.map((r) => [r.initialPose.x, r.initialPose.y, r.initialPose.z]);
  let gridPosition = [0, 0, 0];
  if (p.frameWorldBoundary && p.worldBoundary?.controlBounds) {
    const b = p.worldBoundary.controlBounds;
    assert(
      ["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"].every((k) => Number.isFinite(b[k])),
      "invalid frozen world bounds",
    );
    points.push([b.xMin, b.yMin, b.zMin], [b.xMax, b.yMax, b.zMax]);
    gridPosition = [(b.xMin + b.xMax) / 2, (b.yMin + b.yMax) / 2, p.worldBoundary.groundZ ?? 0];
  }
  const low = [0, 1, 2].map((i) => (points.length ? Math.min(...points.map((a) => a[i])) : 0));
  const high = [0, 1, 2].map((i) => (points.length ? Math.max(...points.map((a) => a[i])) : 0));
  const targetOffset = low.map((v, i) => (v + high[i]) / 2);
  const half = low.map((v, i) => (high[i] - v) / 2);
  const radius = Math.sqrt(half[0] * half[0] + half[1] * half[1] + half[2] * half[2]);
  const hint =
    robots.length === 1 && !p.frameWorldBoundary
      ? robots[0].visualization.initialCameraDistanceMeters || 12
      : Math.max(12, ...robots.map((r) => r.visualization.initialCameraDistanceMeters || 0));
  const distance = Math.max(hint, (radius * 1.15) / Math.sin(Math.PI / 8));
  assert(within(distance, 0.0000001, 1000000), "scene exceeds camera framing bounds");
  const cameraState = {
    perspective: true,
    distance,
    phi: 60,
    thetaOffset: 45,
    target: [0, 0, 0],
    targetOffset,
    targetOrientation: [0, 0, 0, 1],
    fovy: 45,
    near: 0.1,
    far: Math.max(5000, distance * 2),
  };
  const urdf = (roster, scales) =>
    Object.fromEntries(
      roster.flatMap((r, index) => {
        if (!r.visualization.descriptionPackage) {
          return [];
        }
        const id = `xgc2-urdf-${r.name}`;
        const v = {
          layerId: "foxglove.Urdf",
          instanceId: id,
          label: r.name,
          visible: true,
          frameLocked: true,
          sourceType: "topic",
          topic: `${r.namespace}/visual_robot_description`,
          framePrefix: `${frame(r)}/`,
          displayMode: "visual",
          order: index + 2,
        };
        const scale = scales?.[r.kind];
        if (scale && scale !== 1) {
          v.scale = scale;
        }
        return [[id, v]];
      }),
    );
  const layers = urdf(robots, {
    scout_mini: p.scoutModelScale,
    px4_multirotor: p.px4ModelScale,
    mecanum_ugv: p.mecanumModelScale,
  });
  if (p.gridVisible) {
    layers["xgc2-grid"] = {
      visible: true,
      frameLocked: true,
      label: "Grid",
      instanceId: "xgc2-grid",
      layerId: "foxglove.Grid",
      frameId: "world",
      size: p.gridSize,
      divisions: p.gridDivisions,
      lineWidth: p.gridLineWidth,
      color: p.gridColor,
      position: gridPosition,
      rotation: [0, 0, 0],
      order: 1,
    };
  }
  const three = {
    topics: threeTopics,
    followMode: "follow-none",
    followTf: "world",
    transforms: p.axesVisible ? { "frame:world": visible() } : {},
    scene: {
      meshUpAxis: "z_up",
      transforms: {
        showLabel: false,
        axisScale: p.axesVisible ? p.axesScale : 0,
        lineWidth: 0,
      },
    },
    cameraState,
  };
  if (p.sceneNamespace && p.obstacleSceneVisible) {
    three.scene.obstacleScene = { namespace: p.sceneNamespace };
  }
  if (Object.keys(layers).length) {
    three.layers = layers;
  }
  const configById = { "3D!xgc2": three };
  let layout = "3D!xgc2";
  if (p.layoutMode !== "3d") {
    const image = {
      imageMode: {
        imageTopic: p.cameraImageTopic,
        calibrationTopic: p.cameraInfoTopic,
        synchronize: false,
        rotation: 0,
        annotations: {},
      },
      topics: arTopics,
      followMode: "follow-pose",
      scene: {
        meshUpAxis: "z_up",
        labelScaleFactor: 1.25,
        transforms: { showLabel: false, axisScale: 0, lineWidth: 0 },
      },
      cameraState,
    };
    if (obstacleProjection && p.obstacleSceneVisible) {
      image.scene.obstacleScene = {
        namespace: p.sceneNamespace,
        color: [1, 0.5, 0.1, 0.4],
      };
    }
    const imageLayers = urdf(
      simulatedProjection
        ? robots
        : p.runMode === "hybrid"
          ? robots.filter((r) => source(r) === "simulation")
          : [],
      {
        scout_mini: p.scoutModelScale,
        px4_multirotor: p.px4ModelScale,
        mecanum_ugv: p.mecanumModelScale,
      },
    );
    if (Object.keys(imageLayers).length) {
      image.layers = imageLayers;
    }
    configById["Image!xgc2-camera-ar"] = image;
    const reversed = ["camera-ar-3d", "camera-ar-above-3d"].includes(p.layoutMode);
    layout = {
      first: reversed ? "Image!xgc2-camera-ar" : "3D!xgc2",
      second: reversed ? "3D!xgc2" : "Image!xgc2-camera-ar",
      direction: p.layoutMode.includes("above") ? "column" : "row",
      splitPercentage: 45,
    };
    if (p.layoutMode === "3d-above-camera-ar-plot") {
      configById["Plot!xgc2-plot"] = {
        paths: p.plotPaths.map((value) => ({
          value,
          enabled: true,
          timestampMethod: "receiveTime",
        })),
        showLegend: true,
        legendDisplay: "floating",
        showPlotValuesInLegend: false,
        showXAxisLabels: true,
        showYAxisLabels: true,
        isSynced: true,
        xAxisVal: "timestamp",
        sidebarDimension: 240,
      };
      layout = {
        first: "3D!xgc2",
        second: {
          first: "Image!xgc2-camera-ar",
          second: "Plot!xgc2-plot",
          direction: "row",
          splitPercentage: 50,
        },
        direction: "column",
        splitPercentage: 50,
      };
    }
  }
  return {
    schemaVersion: 5,
    parameters: p,
    layout: {
      configById,
      globalVariables: {},
      userNodes: {},
      playbackConfig: { speed: 1, messageOrder: "receiveTime" },
      layout,
    },
  };
}

function readJSONInput() {
  const fs = require("node:fs");
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(65536),
      count = fs.readSync(0, chunk, 0, chunk.length, null);
    if (!count) {
      break;
    }
    total += count;
    assert(total <= 8 * 1024 * 1024, "view input exceeds 8 MiB");
    chunks.push(chunk.subarray(0, count));
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}
module.exports = { VIEWER_DEFAULTS, mapRobotFact, mapViewInput, prepareLayout, readJSONInput };
if (require.main === module) {
  process.stdout.write(JSON.stringify(prepareLayout(mapViewInput(readJSONInput()))));
}
