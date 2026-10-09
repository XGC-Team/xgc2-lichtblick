// SPDX-License-Identifier: MPL-2.0
"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareLayout } = require("../launcher/prepare-layout.cjs");
const fixtures = require("../launcher/testdata/frozen-layouts.json");
for (const f of fixtures)
  test(`preserves ${f.name}`, () => {
    const value = prepareLayout(f.input);
    assert.deepEqual(value.layout, f.layout);
    assert.equal(value.allowedTopics, f.allowedTopics);
  });
test("relay membership contains only the native descriptor and preserves scientific Plot topics", () => {
  const input = structuredClone(fixtures[1].input);
  input.parameters.visualizationTopics[0].maxRateHz = 1;
  input.parameters.plotPaths = ["/venue/reference_cloud.width"];
  const value = prepareLayout(input);
  assert.deepEqual(value.displayRelays, [
    {
      source: "/venue/reference_cloud",
      topic: "/xgc/display/venue/reference_cloud",
      messageType: "sensor_msgs/PointCloud2",
    },
  ]);
  assert(value.allowedTopics.split("\n").includes("/venue/reference_cloud"));
  assert(
    value.allowedTopics
      .split("\n")
      .includes("/xgc/display/venue/reference_cloud"),
  );
  assert(
    value.layout.configById["3D!xgc2"].topics[
      "/xgc/display/venue/reference_cloud"
    ],
  );
});
test("rejects invalid membership and colliding or incremental relay declarations", () => {
  for (const edit of [
    (v) => delete v.robots[0].authoredSimulationSensors,
    (v) => v.robots.push(v.robots[0]),
    (v) => (v.parameters.visualizationTopics[0].topic = "/xgc/scene"),
    (v) => {
      v.parameters.visualizationTopics[0].messageType =
        "visualization_msgs/MarkerArray";
      v.parameters.visualizationTopics[0].maxRateHz = 1;
    },
  ]) {
    const input = structuredClone(fixtures[1].input);
    edit(input);
    assert.throws(() => prepareLayout(input));
  }
});
