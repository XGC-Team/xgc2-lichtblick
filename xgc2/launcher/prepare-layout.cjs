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
const topicPattern = /^\/[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/;
const colorPattern = /^#[0-9a-fA-F]{6}$/;
const relayTypes = new Set([
  "sensor_msgs/PointCloud2",
  "nav_msgs/OccupancyGrid",
  "nav_msgs/Path",
  "geometry_msgs/PoseArray",
]);
const messageTypes = new Set([
  ...relayTypes,
  "visualization_msgs/Marker",
  "visualization_msgs/MarkerArray",
]);
const array = (value) => Array.isArray(value);
const topic = (value) =>
  typeof value === "string" && value.length <= 511 && topicPattern.test(value);
const within = (value, low, high) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= low &&
  value <= high;
const namespaced = (robot, relative) =>
  relative ? `${robot.namespace}/${relative}` : "";
const model = (robot) => robot.visualization.sceneModel || robot.name;
const frame = (robot) =>
  robot.visualization.sceneClass ? `xgc/robots/${model(robot)}` : model(robot);
const display = (declared) =>
  declared.maxRateHz > 0 ? `/xgc/display${declared.topic}` : declared.topic;
const visible = (value = true) => ({ visible: value });
const overlay = (value) => ({ visible: value, showOutlines: false });
const slot = (name) => Number(/\d+$/.exec(name)?.[0] ?? 0);

function prepareLayout(input) {
  assert(
    input &&
      typeof input === "object" &&
      input.parameters &&
      array(input.robots),
    "explicit parameters and frozen robots required",
  );
  assert(input.robots.length <= 256, "at most 256 robots");
  const p = {
    axesVisible: true,
    axesScale: 1,
    scoutModelScale: 1,
    px4ModelScale: 2,
    mecanumModelScale: 1,
    worldBoundaryMode: "walls",
    uavHeightProjection: true,
    predictionLineWidth: 0.01,
    predictionAxisScale: 0.15,
    markerBackgroundColor: "#000000",
    markerBackgroundVisible: false,
    sceneNamespace: "",
    plotPaths: [],
    simpleLidarMaxRateHz: 0,
    simpleLidarMaxMessageBytes: 0,
    frameWorldBoundary: false,
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
  assert(
    ["simulation", "physical", "hybrid"].includes(p.runMode),
    "explicit runMode required",
  );
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
  assert(
    topic(p.cameraImageTopic) &&
      topic(p.cameraInfoTopic) &&
      p.cameraImageTopic !== p.cameraInfoTopic,
    "distinct explicit camera topics required",
  );
  assert(
    !p.sceneNamespace ||
      (topic(p.sceneNamespace) && p.sceneNamespace.length <= 160),
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
    ["predictionAxisScale", 0.01, 10],
  ])
    assert(within(p[key], low, high), `invalid ${key}`);
  assert(Number.isInteger(p.gridDivisions), "integer gridDivisions required");
  for (const key of [
    "gridVisible",
    "axesVisible",
    "uavHeightProjection",
    "markerBackgroundVisible",
    "frameWorldBoundary",
  ])
    assert(typeof p[key] === "boolean", `invalid ${key}`);
  assert(
    ["off", "ground", "walls"].includes(p.worldBoundaryMode),
    "invalid worldBoundaryMode",
  );
  for (const key of ["gridColor", "markerBackgroundColor"]) {
    assert(colorPattern.test(p[key]), `invalid ${key}`);
    p[key] = p[key].toLowerCase();
  }
  for (const key of ["uavPalette", "scoutPalette", "mecanumPalette"])
    if (p[key] != null)
      assert(
        array(p[key]) &&
          p[key].length >= 1 &&
          p[key].length <= 32 &&
          p[key].every((c) => colorPattern.test(c)),
        `invalid ${key}`,
      );
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
      r.initialPose &&
        ["x", "y", "z", "yaw"].every((k) => Number.isFinite(r.initialPose[k])),
      "finite initial pose required",
    );
    assert(
      ["simulation", "physical"].includes(r.hybridSource),
      "frozen hybridSource required",
    );
    assert(
      raw.authoredSimulationSensors &&
        typeof raw.authoredSimulationSensors === "object",
      "authoredSimulationSensors required",
    );
    r.simpleLidar = raw.authoredSimulationSensors.simpleLidar?.enabled === true;
    if (r.kind === "scout_mini" && raw.scout) {
      const mocap = (raw.scout.mocapRigidBodyName || "").trim();
      r.visualization.sceneModel =
        mocap && mocap !== r.name && !r.name.startsWith("ugv") ? mocap : "";
    }
    for (const key of ["odometryTopic", "jointStateTopic", "pathTopic"])
      if (r.visualization[key])
        assert(
          topic(namespaced(r, r.visualization[key])),
          "invalid robot topic",
        );
    assert(
      array(r.visualization.visuals),
      "frozen visualization visuals required",
    );
    if (r.visualization.initialCameraDistanceMeters != null)
      assert(
        within(r.visualization.initialCameraDistanceMeters, 0.1, 100000),
        "invalid camera distance",
      );
    if (r.visualization.pathLineWidthMeters != null)
      assert(
        within(r.visualization.pathLineWidthMeters, 0.001, 100),
        "invalid path width",
      );
    return r;
  });
  assert(
    new Set(robots.map((r) => r.name)).size === robots.length,
    "duplicate robot identity",
  );
  const source = (r) => (p.runMode === "hybrid" ? r.hybridSource : p.runMode);
  const lidar = robots
    .filter((r) => r.simpleLidar && source(r) === "simulation")
    .map((r) => namespaced(r, "simple_lidar/points"));
  const lidarDisplay = (t) =>
    p.simpleLidarMaxRateHz > 0 ? `/xgc/display${t}` : t;
  const history = (r) => {
    const peers = robots
      .filter((v) => v.kind === r.kind)
      .sort(
        (a, b) => slot(a.name) - slot(b.name) || a.name.localeCompare(b.name),
      );
    const palette = p[
      r.kind === "scout_mini"
        ? "scoutPalette"
        : r.kind === "mecanum_ugv"
          ? "mecanumPalette"
          : "uavPalette"
    ] ||
      palettes[r.kind] || ["#f2003c"];
    const color =
      palette[
        peers.findIndex((v) => v.name === r.name) % palette.length
      ].toLowerCase();
    return {
      visible: true,
      type: "line",
      lineWidth: r.visualization.pathLineWidthMeters || 0.02,
      gradient: [color + "80", color + "ff"],
    };
  };
  const physicalPixels = [
    "/usb_cam/video_h264",
    "/usb_cam/image_raw/compressed",
  ].includes(p.cameraImageTopic);
  const obstacleProjection =
    Boolean(p.sceneNamespace) && (p.runMode !== "simulation" || physicalPixels);
  const simulatedProjection = p.runMode === "simulation" && physicalPixels;
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
    [ar ? "/xgc/world_boundary_walls_ar" : "/xgc/world_boundary_walls"]:
      overlay(p.worldBoundaryMode === "walls"),
    [ar ? "/xgc/uav_height_projection_ar" : "/xgc/uav_height_projection"]:
      overlay(p.uavHeightProjection),
    "/xgc/tf": visible(),
    "/tf_static": visible(),
    "/xgc/aligned/scene": overlay(false),
  });
  const threeTopics = topics(false),
    arTopics = topics(true);
  const globalTF = robots.some((r) => !r.visualization.sceneClass);
  if (globalTF) threeTopics["/tf"] = visible();
  if (obstacleProjection || simulatedProjection) arTopics["/tf"] = visible();
  for (const r of robots) {
    if (r.visualization.descriptionPackage)
      threeTopics[`param:${r.namespace}/visual_robot_description`] =
        overlay(false);
    if (r.visualization.odometryTopic)
      threeTopics[namespaced(r, r.visualization.odometryTopic)] = visible();
    if (r.visualization.pathTopic)
      threeTopics[namespaced(r, r.visualization.pathTopic)] = history(r);
    const arPath =
      r.visualization.sceneClass === "fs150"
        ? "ar_path"
        : r.visualization.pathTopic;
    if (arPath) arTopics[namespaced(r, arPath)] = history(r);
    for (const v of r.visualization.visuals)
      threeTopics[`${model(r)}/${v.link}-${v.index}-${v.geometryType}`] = {
        showOutlines: false,
      };
  }
  const declaredSettings = (t) => {
    const s = visible();
    if (t.messageType === "sensor_msgs/PointCloud2")
      Object.assign(s, {
        decayTime: 0,
        pointSize: t.pointSize || 2,
        pointSizeMode: t.pointSizeMode || "screen",
        pointShape:
          t.pointShape || (t.role === "obstacle" ? "square" : "circle"),
        colorMode: "flat",
        colorField: "z",
        flatColor: t.role === "obstacle" ? "#3399ffb3" : "#8f8f8f99",
      });
    if (t.messageType === "nav_msgs/Path") {
      const axes = t.showPoseAxes ?? t.role === "prediction";
      Object.assign(s, {
        type: axes ? "line-axes" : "line",
        lineWidth: t.role === "prediction" ? p.predictionLineWidth : 0.04,
        gradient:
          t.role === "prediction"
            ? ["#ffbf00ff", "#ffbf0040"]
            : ["#000000ff", "#00000040"],
      });
      if (axes) s.axisScale = p.predictionAxisScale;
    }
    if (t.messageType === "geometry_msgs/PoseArray" && t.role === "prediction")
      Object.assign(s, { type: "arrow", gradient: ["#ffbf00ff", "#ffbf0040"] });
    for (const k of ["lineWidth", "markerScale"]) if (t[k] != null) s[k] = t[k];
    if (t.color) {
      if (t.messageType === "sensor_msgs/PointCloud2") s.flatColor = t.color;
      if (["nav_msgs/Path", "geometry_msgs/PoseArray"].includes(t.messageType))
        s.gradient = [t.color, t.color];
    }
    return s;
  };
  const allowed = new Set([
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
    p.cameraImageTopic,
    p.cameraInfoTopic,
  ]);
  if (globalTF || p.sceneNamespace) allowed.add("/tf");
  if (p.sceneNamespace)
    for (const suffix of [
      "snapshot",
      "state",
      "document",
      "consumer_status",
      "markers",
    ])
      allowed.add(`${p.sceneNamespace}/${suffix}`);
  for (const r of robots) {
    for (const relative of [
      r.visualization.odometryTopic,
      r.visualization.jointStateTopic,
      r.visualization.pathTopic,
    ])
      if (relative) allowed.add(namespaced(r, relative));
    if (r.visualization.sceneClass === "fs150")
      allowed.add(namespaced(r, "ar_path"));
  }
  for (const t of lidar) {
    allowed.add(lidarDisplay(t));
    threeTopics[lidarDisplay(t)] = {
      visible: true,
      pointSize: 2,
      decayTime: 0,
      colorMode: "colormap",
      colorMap: "turbo",
      colorField: "z",
    };
  }
  const displayRelays = [],
    declaredNames = new Set(allowed);
  for (const t of p.visualizationTopics) {
    assert(
      topic(t.topic) &&
        !t.topic.startsWith("/xgc/display/") &&
        !declaredNames.has(t.topic),
      "invalid or colliding declared topic",
    );
    declaredNames.add(t.topic);
    assert(
      messageTypes.has(t.messageType) &&
        ["prediction", "obstacle", "semantic"].includes(t.role),
      "unsupported visualization declaration",
    );
    assert(
      typeof t.visible3d === "boolean" &&
        typeof t.visibleAr === "boolean" &&
        typeof t.expectedFrame === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(
          t.expectedFrame,
        ),
      "invalid visibility or expected frame",
    );
    checkRate(t.maxRateHz || 0, t.maxMessageBytes || 0);
    if (t.maxRateHz) {
      assert(
        relayTypes.has(t.messageType),
        "incremental messages cannot be throttled",
      );
      displayRelays.push({
        source: t.topic,
        topic: display(t),
        messageType: t.messageType,
      });
    }
    if (t.lineWidth != null)
      assert(within(t.lineWidth, 0.0001, 100), "invalid line width");
    if (t.markerScale != null)
      assert(within(t.markerScale, 0.0001, 100000), "invalid marker scale");
    if (t.color)
      assert(/^#[0-9a-fA-F]{8}$/.test(t.color), "invalid layer color");
    if (t.pointSize != null)
      assert(within(t.pointSize, 0.1, 64), "invalid point size");
    if (t.pointShape)
      assert(
        ["circle", "square"].includes(t.pointShape),
        "invalid point shape",
      );
    if (t.pointSizeMode)
      assert(
        ["screen", "world"].includes(t.pointSizeMode),
        "invalid point size mode",
      );
    if (p.sceneNamespace && t.role === "obstacle")
      assert(
        !t.messageType.startsWith("visualization_msgs/"),
        "bound scene owns obstacle geometry",
      );
    allowed.add(display(t));
    if (t.visible3d || t.role === "obstacle")
      threeTopics[display(t)] = declaredSettings(t);
    if (t.role === "obstacle") {
      if (p.runMode !== "simulation")
        arTopics[display(t)] = { ...declaredSettings(t), color: "#ff801a66" };
    } else if (t.visibleAr) arTopics[display(t)] = declaredSettings(t);
  }
  if (p.simpleLidarMaxRateHz)
    for (const t of lidar)
      displayRelays.push({
        source: t,
        topic: lidarDisplay(t),
        messageType: "sensor_msgs/PointCloud2",
      });
  displayRelays.sort((a, b) => (a.source < b.source ? -1 : 1));
  for (const t of p.transformTopics) {
    assert(
      topic(t) && !declaredNames.has(t),
      "invalid or colliding transform topic",
    );
    declaredNames.add(t);
    allowed.add(t);
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
    allowed.add(path.split(".")[0]);
  }
  assert(
    [...allowed].every(topic) && allowed.size <= 1024,
    "invalid or oversized topic allowlist",
  );
  const allowedTopics = [...allowed].sort().join("\n");
  assert(
    Buffer.byteLength(allowedTopics) <= 65536,
    "oversized topic allowlist",
  );
  const points = robots.map((r) => [
    r.initialPose.x,
    r.initialPose.y,
    r.initialPose.z,
  ]);
  let gridPosition = [0, 0, 0];
  if (p.frameWorldBoundary && p.worldBoundary?.controlBounds) {
    const b = p.worldBoundary.controlBounds;
    assert(
      ["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"].every((k) =>
        Number.isFinite(b[k]),
      ),
      "invalid frozen world bounds",
    );
    points.push([b.xMin, b.yMin, b.zMin], [b.xMax, b.yMax, b.zMax]);
    gridPosition = [
      (b.xMin + b.xMax) / 2,
      (b.yMin + b.yMax) / 2,
      p.worldBoundary.groundZ ?? 0,
    ];
  }
  const low = [0, 1, 2].map((i) =>
    points.length ? Math.min(...points.map((a) => a[i])) : 0,
  );
  const high = [0, 1, 2].map((i) =>
    points.length ? Math.max(...points.map((a) => a[i])) : 0,
  );
  const targetOffset = low.map((v, i) => (v + high[i]) / 2);
  const half = low.map((v, i) => (high[i] - v) / 2);
  const radius = Math.sqrt(
    half[0] * half[0] + half[1] * half[1] + half[2] * half[2],
  );
  const hint =
    robots.length === 1 && !p.frameWorldBoundary
      ? robots[0].visualization.initialCameraDistanceMeters || 12
      : Math.max(
          12,
          ...robots.map(
            (r) => r.visualization.initialCameraDistanceMeters || 0,
          ),
        );
  const distance = Math.max(hint, (radius * 1.15) / Math.sin(Math.PI / 8));
  assert(
    within(distance, 0.0000001, 1000000),
    "scene exceeds camera framing bounds",
  );
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
        if (!r.visualization.descriptionPackage) return [];
        const id = `xgc2-urdf-${r.name}`;
        const v = {
          layerId: "foxglove.Urdf",
          instanceId: id,
          label: r.name,
          visible: true,
          frameLocked: true,
          sourceType: "param",
          parameter: `${r.namespace}/visual_robot_description`,
          framePrefix: `${frame(r)}/`,
          displayMode: "visual",
          order: index + 2,
        };
        const scale = scales?.[r.kind];
        if (scale && scale !== 1) v.scale = scale;
        return [[id, v]];
      }),
    );
  const layers = urdf(robots, {
    scout_mini: p.scoutModelScale,
    px4_multirotor: p.px4ModelScale,
    mecanum_ugv: p.mecanumModelScale,
  });
  if (p.gridVisible)
    layers["xgc2-grid"] = {
      visible: true,
      frameLocked: true,
      label: "Grid",
      instanceId: "xgc2-grid",
      layerId: "foxglove.Grid",
      size: p.gridSize,
      divisions: p.gridDivisions,
      lineWidth: p.gridLineWidth,
      color: p.gridColor,
      position: gridPosition,
      rotation: [0, 0, 0],
      order: 1,
    };
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
  if (p.sceneNamespace)
    three.scene.obstacleScene = { namespace: p.sceneNamespace };
  if (Object.keys(layers).length) three.layers = layers;
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
    if (obstacleProjection)
      image.scene.obstacleScene = {
        namespace: p.sceneNamespace,
        color: [1, 0.5, 0.1, 0.4],
      };
    const imageLayers = urdf(
      simulatedProjection
        ? robots
        : p.runMode === "hybrid"
          ? robots.filter((r) => source(r) === "simulation")
          : [],
    );
    if (Object.keys(imageLayers).length) image.layers = imageLayers;
    configById["Image!xgc2-camera-ar"] = image;
    const reversed = ["camera-ar-3d", "camera-ar-above-3d"].includes(
      p.layoutMode,
    );
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
    allowedTopics,
    displayRelays,
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
    if (!count) break;
    total += count;
    assert(total <= 8 * 1024 * 1024, "layout input exceeds 8 MiB");
    chunks.push(chunk.subarray(0, count));
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}
module.exports = { prepareLayout, readJSONInput };
if (require.main === module)
  process.stdout.write(JSON.stringify(prepareLayout(readJSONInput())));
