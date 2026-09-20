// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const directory = process.env.XGC2_OFFLINE_TEST_BUILD;
if (!directory) {
  throw new Error("Run web/offline-tests/run.cjs");
}
const s = require(path.join(directory, "cjs/state.js"));
const c = require(path.join(directory, "cjs/capture.js"));
const sha = "a".repeat(64),
  base = 1700000000000000000n;
function fixture() {
  const asset = { path: `assets/${sha}.json`, sha256: sha, size: 100 };
  return {
    schema: "xgc2.video-snapshot",
    version: 1,
    bagStartNs: String(base),
    recipe: {
      source: { cameraTopic: "/image" },
      interval: { startNs: "0", endNs: "100000000" },
      output: { width: 3840, height: 2160, fps: 30 },
    },
    policy: { maxFrameAgeNs: "100000000", tfLookaheadNs: "100000000" },
    events: asset,
    topics: [{ name: "/info", schemaName: "sensor_msgs/CameraInfo" }],
    rendererConfig: {},
    cameraFrames: [
      {
        sourceFrameId: "0",
        logTimeNs: String(base),
        cameraTimeNs: String(base),
        width: 3840,
        height: 2160,
        format: "png",
        asset,
        header: { frame_id: "optical", stamp: { sec: 1700000000, nsec: 0 } },
      },
    ],
  };
}
function plan(n = 0) {
  return {
    snapshotSha256: sha,
    frameIndex: n,
    targetTimeNs: String((BigInt(n) * 1000000000n) / 30n),
    sourceFrameId: "0",
    cameraTimeNs: String(base),
    width: 3840,
    height: 2160,
  };
}
test("native-side selection validates the indexed frame rather than echoing the host", () => {
  const f = s.parseSnapshot(fixture());
  assert.equal(s.selectFrame(f, plan(2), sha).sourceFrameId, "0");
});
for (const changed of [
  { frameIndex: -1 },
  { frameIndex: 3 },
  { targetTimeNs: "1" },
  { sourceFrameId: "wrong" },
  { cameraTimeNs: "1" },
  { width: 1920 },
  { snapshotSha256: "b".repeat(64) },
]) {
  test(`refuse mismatched plan ${JSON.stringify(changed)}`, () =>
    assert.throws(() => s.selectFrame(fixture(), { ...plan(), ...changed }, sha)));
}
test("shuffled target requests reproduce the same camera mapping", () => {
  const f = fixture();
  for (const n of [2, 0, 1, 2, 1, 0]) {
    assert.equal(s.selectFrame(f, plan(n), sha).cameraTimeNs, String(base));
  }
});
test("source gap and timestamp reset fail", () => {
  const f = fixture();
  f.policy.maxFrameAgeNs = "1";
  assert.throws(() => s.selectFrame(f, plan(1), sha), /gap/);
  const g = fixture();
  g.cameraFrames.push({ ...g.cameraFrames[0], sourceFrameId: "other" });
  assert.throws(() => s.parseSnapshot(g), /increasing/);
});
test("event validator rejects undeclared schemas, mesh assets, role mismatch and time disorder", () => {
  const row = {
    timeNs: "1",
    role: "data",
    event: {
      topic: "/info",
      schemaName: "sensor_msgs/CameraInfo",
      message: {},
      receiveTime: { sec: 0, nsec: 1 },
      sizeInBytes: 1,
    },
  };
  assert.equal(s.parseEvents([row], fixture().topics).length, 1);
  assert.throws(() => s.parseEvents([{ ...row, role: "tf" }], fixture().topics));
  assert.throws(() => s.parseEvents([row, { ...row, timeNs: "0" }], fixture().topics));
  assert.throws(() =>
    s.parseEvents([{ ...row, event: { ...row.event, schemaName: "unknown" } }], fixture().topics),
  );
  assert.throws(() =>
    s.parseEvents(
      [
        {
          ...row,
          event: { ...row.event, schemaName: "visualization_msgs/Marker", message: { type: 10 } },
        },
      ],
      [{ name: "/info", schemaName: "visualization_msgs/Marker" }],
    ),
  );
});
test("RGBA row orientation flips once and validates buffer dimensions", () => {
  const pixels = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(c.flipRows(pixels, 1, 2)), [5, 6, 7, 8, 1, 2, 3, 4]);
  for (const [w, h] of [
    [0, 2],
    [-1, 2],
    [2, 2],
    [1.5, 2],
    [20000, 1],
  ]) {
    assert.throws(() => c.flipRows(pixels, w, h));
  }
});
test("GPU readback restores pack and framebuffer state even on error", () => {
  const keys = [
    "READ_FRAMEBUFFER_BINDING",
    "PIXEL_PACK_BUFFER_BINDING",
    "PACK_ALIGNMENT",
    "PACK_ROW_LENGTH",
    "PACK_SKIP_ROWS",
    "PACK_SKIP_PIXELS",
  ];
  const values = new Map(keys.map((k) => [k, k + "-initial"]));
  const gl = {
    drawingBufferWidth: 1,
    drawingBufferHeight: 2,
    isContextLost: () => false,
    getParameter: (k) => values.get(k),
    bindFramebuffer: (_, v) => values.set("READ_FRAMEBUFFER_BINDING", v),
    bindBuffer: (_, v) => values.set("PIXEL_PACK_BUFFER_BINDING", v),
    pixelStorei: (k, v) => values.set(k, v),
    finish: () => {},
    readPixels: (_x, _y, _w, _h, _fmt, _type, buffer) => buffer.set([1, 2, 3, 4, 5, 6, 7, 8]),
    getError: () => 0,
    NO_ERROR: 0,
  };
  for (const k of keys) {
    gl[k] = k;
  }
  assert.deepEqual(Array.from(c.readFramePixels(gl, 1, 2)), [5, 6, 7, 8, 1, 2, 3, 4]);
  for (const k of keys) {
    assert.equal(values.get(k), k + "-initial");
  }
  gl.getError = () => 1;
  assert.throws(() => c.readFramePixels(gl, 1, 2), /readback/);
  for (const k of keys) {
    assert.equal(values.get(k), k + "-initial");
  }
});
test("actual Chromium WebGL2 3840x2160 readback and persistent canvas", {
  skip: !process.env.XGC2_CHROMIUM,
  timeout: 20000,
}, async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "xgc2-gl-test-"));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  const html = `<!doctype html><body><script type="module">
  import {readFramePixels} from '/capture.js';
  try {
    const canvas=document.createElement('canvas');canvas.width=3840;canvas.height=2160;
    const gl=canvas.getContext('webgl2',{antialias:false});if(!gl)throw Error('WebGL2 unavailable');
    gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0,1080,3840,1080);gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);
    const pixels=readFramePixels(gl,3840,2160);
    const top=Array.from(pixels.slice(0,4));const bottom=Array.from(pixels.slice(-4));
    if(String(top)!=='255,0,0,255'||String(bottom)!=='0,0,255,255')throw Error('Incorrect orientation '+top+' '+bottom);
    const out=document.createElement('canvas');out.width=3840;out.height=2160;
    const ctx=out.getContext('2d');ctx.putImageData(new ImageData(pixels,3840,2160),0,0);
    gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    if(String(Array.from(ctx.getImageData(0,0,1,1).data))!=='255,0,0,255')throw Error('Capture changed with renderer');
    document.body.textContent='PASS:4K-WebGL2-readback';
  } catch(error){document.body.textContent='FAIL:'+error.message;}
  </script>`;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/capture.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(await fs.readFile(path.join(directory, "esm/capture.js")));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const child = spawn(process.env.XGC2_CHROMIUM, [
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-first-run",
    "--disable-background-networking",
    "--user-data-dir=" + profile,
    "--virtual-time-budget=5000",
    "--dump-dom",
    url,
  ]);
  t.after(() => child.kill("SIGKILL"));
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-8000)));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /PASS:4K-WebGL2-readback/, stdout + stderr);
});

test("offline TF window retains long experiments without the live two-second cutoff", () => {
  const h = require(path.join(directory, "cjs/history.js"));
  function row(stamp, child = "robot") {
    return {
      timeNs: String(stamp),
      role: "tf",
      event: {
        message: {
          transforms: [
            {
              child_frame_id: child,
              header: {
                stamp: { sec: Number(stamp / 1000000000n), nsec: Number(stamp % 1000000000n) },
              },
            },
          ],
        },
      },
    };
  }
  const bounds = { maxStorageTime: 600000000000n, maxCapacityPerFrame: 76800 };
  const history = Array.from({ length: 420 }, (_, n) => row(base + BigInt(n) * 1000000000n));
  h.validateTransformHistory(history, bounds);
  assert.throws(
    () => h.validateTransformHistory([row(base), row(base + 600000000000n)], bounds),
    /window/,
  );
});
test("TF capacity and canonical frame aliases cannot silently trim history", () => {
  const h = require(path.join(directory, "cjs/history.js"));
  const row = (stamp, child) => ({
    timeNs: String(stamp),
    role: "tf",
    event: {
      message: {
        transforms: [{ child_frame_id: child, header: { stamp: { sec: 0, nsec: stamp } } }],
      },
    },
  });
  assert.throws(
    () =>
      h.validateTransformHistory([row(1, "/robot"), row(2, "robot")], {
        maxStorageTime: 100n,
        maxCapacityPerFrame: 2,
      }),
    /capacity/,
  );
  assert.throws(
    () =>
      h.validateTransformHistory([{ ...row(1, "robot"), role: "tf-static" }, row(2, "robot")], {
        maxStorageTime: 100n,
        maxCapacityPerFrame: 4,
      }),
    /mix/,
  );
});
test("latched static TF old timestamp remains valid", () => {
  const h = require(path.join(directory, "cjs/history.js"));
  h.validateTransformHistory(
    [
      {
        timeNs: String(base),
        role: "tf-static",
        event: {
          message: {
            transforms: [{ child_frame_id: "camera", header: { stamp: { sec: 0, nsec: 1 } } }],
          },
        },
      },
    ],
    { maxStorageTime: 600000000000n, maxCapacityPerFrame: 76800 },
  );
});

test("interactive preview shares the offline query channel", () => {
  const i = require(path.join(directory, "cjs/interactive.js"));
  assert.equal(i.interactivePreviewEnabled("?xgcTfHistorySeconds=600&xgcInteractive=1"), true);
  assert.equal(i.interactivePreviewEnabled("?xgcInteractive=1&xgcTfHistorySeconds=600"), true);
  assert.equal(i.interactivePreviewEnabled("?xgcTfHistorySeconds=600"), false);
  assert.equal(i.interactivePreviewEnabled("?xgcInteractive=0"), false);
  assert.equal(i.interactivePreviewEnabled("?xgcInteractive=true"), false);
  assert.equal(i.interactivePreviewEnabled(""), false);
});
test("DPR=1 capture requirement is relaxed only for interactive frames", () => {
  const i = require(path.join(directory, "cjs/interactive.js"));
  i.requireCapturePixelRatio(1, { interactive: false });
  i.requireCapturePixelRatio(1, { interactive: true });
  i.requireCapturePixelRatio(1.25, { interactive: true });
  i.requireCapturePixelRatio(2, { interactive: true });
  assert.throws(
    () => i.requireCapturePixelRatio(1.25, { interactive: false }),
    /devicePixelRatio=1/,
  );
  assert.throws(() => i.requireCapturePixelRatio(2, { interactive: false }), /devicePixelRatio=1/);
});
test("interactive scrub failure does not taint; strict capture still taints", () => {
  const i = require(path.join(directory, "cjs/interactive.js"));
  assert.equal(i.taintsOnFrameError({ interactive: true }), false);
  assert.equal(i.taintsOnFrameError({ interactive: false }), true);
});

test("mapped camera clock selects source while frame ACK preserves raw stamp", () => {
  const f = fixture();
  f.cameraFrames[0].cameraTimeNs = "5000000000";
  f.cameraFrames[0].header.stamp = { sec: 5, nsec: 0 };
  f.cameraFrames[0].logTimeNs = String(base + 50_000_000n);
  f.cameraFrames[0].renderTimeNs = String(base);
  const parsed = s.parseSnapshot(f);
  const p = { ...plan(0), cameraTimeNs: "5000000000" };
  assert.equal(s.selectFrame(parsed, p, sha).sourceFrameId, "0");
  assert.equal(s.selectFrame(parsed, p, sha).cameraTimeNs, "5000000000");
});
test("track fades use output time, including held camera images and backward seeks", () => {
  const { trackOpacity, parseTracks } = require(path.join(directory, "cjs/scene.js"));
  const track = {
    id: "a",
    label: "A",
    kind: "markers",
    selector: { kind: "topic", topic: "/obstacle" },
    span: { startNs: "1000000000", endNs: "4000000000" },
    animation: { fadeInNs: "1000000000", fadeOutNs: "1000000000", easing: "linear" },
    style: { opacity: 0.8, scale: 1, presentation: "recorded" },
  };
  parseTracks([track]);
  const at = (t) => trackOpacity(track, BigInt(t));
  assert.equal(at("1000000000"), 0);
  assert.equal(at("1500000000"), 0.4);
  assert.equal(at("2500000000"), 0.8);
  assert.equal(at("3500000000"), 0.4);
  assert.equal(at("4000000000"), 0);
  assert.equal(at("1500000000"), 0.4);
  assert.throws(
    () => parseTracks([{ ...track, animation: { ...track.animation, fadeOutNs: "4000000000" } }]),
    /fade/,
  );
});

function modelFixture() {
  const f = fixture();
  f.tracks = [
    {
      id: "scout",
      label: "Scout",
      kind: "robot-model",
      source: { modelId: "scout-mini-visual", frameId: "world/scout/base_link", bundleSha256: sha },
      span: { startNs: "0", endNs: "100000000" },
      animation: { fadeInNs: "0", fadeOutNs: "0", easing: "linear" },
      style: { scale: 1, opacity: 1 },
    },
  ];
  f.models = [
    {
      trackId: "scout",
      modelId: "scout-mini-visual",
      frameId: "world/scout/base_link",
      framePrefix: "__xgc_video_scout/",
      asset: { path: `assets/${sha}.json`, sha256: sha, size: 100 },
      bundleSha256: sha,
      provenance: "operator-selected-controlled",
      jointPose: "urdf-rest",
      resources: [
        {
          uri: `https://xgc2.invalid/models/${sha}/meshes/wheel.dae`,
          asset: { path: `assets/${sha}.dae`, sha256: sha, size: 100 },
          mediaType: "model/vnd.collada+xml",
        },
      ],
    },
  ];
  return f;
}

test("disabled tracks retain their override identity at every seek", () => {
  const { parseTracks, activeTrack, trackOpacity } = require(path.join(directory, "cjs/scene.js"));
  const track = { ...modelFixture().tracks[0], enabled: false };
  const tracks = parseTracks([track]);
  for (const time of [0n, 1n, 99999999n, 1n]) {
    assert.equal(activeTrack(tracks, time), track);
    assert.equal(trackOpacity(track, time), 0);
  }
  track.enabled = true;
  assert.equal(trackOpacity(track, 1n), 1);
  assert.throws(() => parseTracks([{ ...track, enabled: "false" }]), /visibility/);
});

test("frozen models bind exact track identity, resources and digest", () => {
  const f = modelFixture();
  assert.equal(s.parseSnapshot(f).models[0].resources[0].mediaType, "model/vnd.collada+xml");
  for (const change of [
    (m) => (m.trackId = "other"),
    (m) => (m.frameId = "other"),
    (m) => (m.framePrefix = "live/"),
    (m) => (m.bundleSha256 = "b".repeat(64)),
    (m) => (m.provenance = "recorded-bundle"),
    (m) => (m.jointPose = "recorded"),
    (m) => (m.resources[0].uri += "?url=file:///etc/passwd"),
    (m) => (m.resources[0].uri = `https://xgc2.invalid/models/${sha}/../wheel.dae`),
    (m) => (m.resources[0].uri = `https://xgc2.invalid/models/${sha}/%2e%2e/wheel.dae`),
    (m) => (m.resources[0].mediaType = "text/javascript"),
    (m) => m.resources.push({ ...m.resources[0] }),
    (m) => (m.resources[0].asset.path = `assets/${sha}.js`),
    (m) => (m.resources[0].asset.size = 32 * 1024 * 1024 + 1),
  ]) {
    const invalid = modelFixture();
    change(invalid.models[0]);
    assert.throws(() => s.parseSnapshot(invalid));
  }
  const missing = modelFixture();
  missing.models = [];
  assert.throws(() => s.parseSnapshot(missing), /Missing frozen/);
  const duplicate = modelFixture();
  duplicate.models.push(duplicate.models[0]);
  assert.throws(() => s.parseSnapshot(duplicate), /Unbound/);
});

test("legacy primitive models keep the original undigested wire", () => {
  const f = modelFixture();
  const t = f.tracks[0],
    m = f.models[0];
  t.source.modelId = m.modelId = "mocap-rotor";
  delete t.source.bundleSha256;
  for (const key of ["bundleSha256", "provenance", "jointPose", "resources"]) {
    delete m[key];
  }
  assert.equal(s.parseSnapshot(f).models[0], m);
  assert.equal(Object.hasOwn(t.source, "bundleSha256"), false);
});

test("frozen resource URI extensions cannot select a different native loader", () => {
  const f = modelFixture();
  f.models[0].resources[0].uri = f.models[0].resources[0].uri.replace(/\.dae$/, ".gltf");
  assert.throws(() => s.parseSnapshot(f), /resource type/);
  const jpeg = modelFixture();
  const resource = jpeg.models[0].resources[0];
  resource.uri = resource.uri.replace(/\.dae$/, ".jpeg");
  resource.mediaType = "image/jpeg";
  resource.asset.path = `assets/${sha}.jpg`;
  assert.equal(s.parseSnapshot(jpeg).models[0].resources[0], resource);
});

test("frozen DAE bytes reject GLB magic and glTF JSON before native dispatch", async () => {
  const crypto = require("node:crypto");
  const oldFetch = global.fetch,
    oldLocation = global.location;
  global.location = { origin: "http://station.invalid" };
  try {
    for (const bytes of [
      Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]),
      Buffer.from('{"asset":{"version":"2.0"},"buffers":[{"uri":"https://outside.invalid"}]}'),
    ]) {
      const f = modelFixture(),
        resource = f.models[0].resources[0],
        hash = crypto.createHash("sha256").update(bytes).digest("hex");
      resource.asset = { path: `assets/${hash}.dae`, sha256: hash, size: bytes.length };
      s.parseSnapshot(f);
      global.fetch = async (url) => {
        const response = new Response(bytes);
        Object.defineProperty(response, "url", { value: url.href });
        return response;
      };
      await assert.rejects(
        s.fetchFrozenModelAsset(
          f.models,
          new URL("http://station.invalid/snapshot/"),
          resource.uri,
        ),
        /model resource format/,
      );
    }
  } finally {
    global.fetch = oldFetch;
    global.location = oldLocation;
  }
});

test("model assets use only exact snapshot mapping and verified bytes", async () => {
  const crypto = require("node:crypto");
  const bytes = Buffer.from("<COLLADA/>");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const f = modelFixture(),
    resource = f.models[0].resources[0];
  resource.asset = { path: `assets/${hash}.dae`, sha256: hash, size: bytes.length };
  let calls = 0;
  const oldFetch = global.fetch,
    oldLocation = global.location;
  global.location = { origin: "http://station.invalid" };
  global.fetch = async (url) => {
    calls++;
    return {
      ok: true,
      url: url.href,
      headers: new Headers(),
      body: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(bytes));
          c.close();
        },
      }),
    };
  };
  try {
    const baseURL = new URL("http://station.invalid/snapshot/");
    const result = await s.fetchFrozenModelAsset(f.models, baseURL, resource.uri);
    assert.equal(result.mediaType, "model/vnd.collada+xml");
    assert.deepEqual(Buffer.from(result.data), bytes);
    await assert.rejects(
      s.fetchFrozenModelAsset(f.models, baseURL, "package://scout_description/meshes/wheel.dae"),
      /closure/,
    );
    await assert.rejects(
      s.fetchFrozenModelAsset(f.models, baseURL, resource.uri + "?next=1"),
      /closure/,
    );
    assert.equal(calls, 1);
    resource.asset.sha256 = "b".repeat(64);
    resource.asset.path = `assets/${resource.asset.sha256}.dae`;
    await assert.rejects(s.fetchFrozenModelAsset(f.models, baseURL, resource.uri), /hash/);
  } finally {
    global.fetch = oldFetch;
    global.location = oldLocation;
  }
});

test("static TF availability remains record time with original stamps kept only as provenance", () => {
  const { validateTransformHistory } = require(path.join(directory, "cjs/history.js"));
  const row = (time, raw) => ({
    role: "tf-static",
    timeNs: String(base + time),
    provenance: { recordTimeNs: String(base + time), sampleTimeNs: String(raw) },
    event: {
      topic: "/tf_static",
      schemaName: "tf2_msgs/TFMessage",
      receiveTime: { sec: 1700000000, nsec: Number(time) },
      message: {
        transforms: [
          { header: { frame_id: "world", stamp: { sec: 0, nsec: 0 } }, child_frame_id: "map" },
        ],
      },
    },
  });
  const rows = [row(0n, 0n), row(20_000_000n, base)];
  validateTransformHistory(rows, { maxStorageTime: 600_000_000_000n, maxCapacityPerFrame: 1000 });
  // A backward seek rebuilds only the static revisions already available then.
  const available = (time) =>
    rows.filter((r) => BigInt(r.timeNs) <= base + time).map((r) => r.provenance.sampleTimeNs);
  assert.deepEqual(available(30_000_000n), ["0", String(base)]);
  assert.deepEqual(available(10_000_000n), ["0"]);
});

test("snapshot SHA-256 remains exact without secure-context WebCrypto", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, "crypto", original);
    } else {
      delete globalThis.crypto;
    }
  });
  for (const crypto of [undefined, {}]) {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
    assert.equal(
      await s.digest(new TextEncoder().encode("abc").buffer),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  }
});

// Source evidence stays tied to the original AU; native Images still consume PNG.
test("H264 prepared frames require exact bounded decode evidence and lossless pixels", () => {
  const valid = fixture();
  valid.recipe.source.messageType = "foxglove_msgs/CompressedVideo";
  valid.cameraFrames[0].asset.path = `assets/${sha}.png`;
  valid.cameraFrames[0].sourceEncoding = {
    codec: "h264",
    accessUnitSha256: sha,
    accessUnitSize: 8192,
    decodeIndex: 23,
  };
  assert.equal(s.parseSnapshot(structuredClone(valid)).cameraFrames[0].cameraTimeNs, String(base));
  for (const patch of [
    { codec: "hevc" },
    { accessUnitSha256: "bad" },
    { accessUnitSize: 0 },
    { accessUnitSize: 8 * 1024 * 1024 + 1 },
    { accessUnitSize: 1.5 },
    { decodeIndex: -1 },
    { decodeIndex: 100000 },
    { decodeIndex: 1.5 },
    { decodeIndex: Number.MAX_SAFE_INTEGER + 1 },
    { arbitrary: true },
  ]) {
    const changed = structuredClone(valid);
    Object.assign(changed.cameraFrames[0].sourceEncoding, patch);
    assert.throws(() => s.parseSnapshot(changed), /decode evidence/);
  }
  for (const change of [
    (v) => {
      delete v.cameraFrames[0].sourceEncoding;
    },
    (v) => {
      v.cameraFrames[0].format = "jpeg";
    },
    (v) => {
      v.cameraFrames[0].asset.path = `assets/${sha}.jpg`;
    },
    (v) => {
      v.recipe.source.messageType = "sensor_msgs/CompressedImage";
    },
    (v) => {
      delete v.recipe.source.messageType;
    },
  ]) {
    const changed = structuredClone(valid);
    change(changed);
    assert.throws(() => s.parseSnapshot(changed), /decode evidence/);
  }
  const repeated = structuredClone(valid);
  const frame = repeated.cameraFrames[0];
  repeated.cameraFrames.push({
    ...frame,
    sourceFrameId: "next",
    logTimeNs: String(base + 1n),
    cameraTimeNs: String(base + 1n),
    header: { ...frame.header, stamp: { sec: 1700000000, nsec: 1 } },
  });
  assert.throws(() => s.parseSnapshot(repeated), /decode evidence/);
  const legacy = fixture();
  assert.equal(s.parseSnapshot(legacy).cameraFrames[0].sourceEncoding, undefined);
});
