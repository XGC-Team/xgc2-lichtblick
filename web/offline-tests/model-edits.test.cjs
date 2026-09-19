// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const esbuild = require("esbuild");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const THREE = require("three");

test("native offline edits keep model colours independent and restore opacity on backward seeks", async (t) => {
  const root = path.resolve(__dirname, "../..");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xgc2-model-edits-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  const bundled = await esbuild.build({
    entryPoints: [path.join(root, "web/src/offline/edits.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    alias: {
      "@lichtblick/suite-base": path.join(root, "packages/suite-base/src"),
      "@lichtblick/den": path.join(root, "packages/den"),
    },
    write: false,
  });
  const compiled = path.join(directory, "model-edits.cjs");
  await fs.writeFile(compiled, bundled.outputFiles[0].text);
  const { OfflineEdits } = require(compiled);
  const track = (id, color) => ({
    id,
    label: id,
    kind: "robot-model",
    source: { modelId: "mocap-rotor", frameId: id },
    span: { startNs: "0", endNs: "100" },
    animation: { fadeInNs: "20", fadeOutNs: "0", easing: "linear" },
    style: { color, opacity: 0.5, scale: 1 },
  });
  const a = track("a", "#ff0000"),
    b = track("b", "#0000ff");
  const geometry = new THREE.BoxGeometry();
  const original = new THREE.MeshStandardMaterial({ color: "#008000", opacity: 0.8 });
  const ma = original.clone(),
    mb = original.clone();
  const ga = new THREE.Group(),
    gb = new THREE.Group();
  ga.add(new THREE.Mesh(geometry, ma));
  gb.add(new THREE.Mesh(geometry, mb));
  const edits = new OfflineEdits({ settings: { setNodesForKey() {} } }, [a, b], {
    urdfs: {
      renderables: new Map([
        ["a", ga],
        ["b", gb],
      ]),
    },
  });
  await Promise.resolve();
  for (const time of [20n, 50n, 10n, 50n]) {
    ga.visible = gb.visible = true;
    edits.time = time;
    edits.startFrame();
    assert.equal(ma.color.getHexString(), "ff0000");
    assert.equal(mb.color.getHexString(), "0000ff");
    assert.equal(ma.opacity, time === 10n ? 0.2 : 0.4);
    assert.equal(original.opacity, 0.8);
  }
  a.enabled = false;
  edits.startFrame();
  assert.equal(ga.visible, false);
  assert.equal(gb.visible, true);
  a.enabled = true;
  delete a.style.color;
  ga.visible = true;
  edits.startFrame();
  assert.equal(ga.visible, true);
  assert.equal(ma.opacity, 0.4);
  assert.equal(ma.color.getHexString(), "008000");
  assert.equal(mb.color.getHexString(), "0000ff");
  assert.equal(original.color.getHexString(), "008000");
  edits.dispose();
  geometry.dispose();
  original.dispose();
  ma.dispose();
  mb.dispose();
});
