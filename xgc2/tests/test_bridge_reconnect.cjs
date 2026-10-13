// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const { fork, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocket, WebSocketServer } = require("ws");

const { rawCall } = require("./control_fixture.cjs");
const { ORIGIN, startLauncher } = require("./launcher_fixture.cjs");
const { PLAYER, playerHarness } = require("./player_reconnect_fixture.cjs");

async function until(predicate, timeoutMs = 5000, context = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `condition timed out ${context()}`);
    await delay(10);
  }
}
async function unusedPort() {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}
async function bridge(t, port, sessionId = "first") {
  const received = [];
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port,
    handleProtocols: () => "foxglove.websocket.v1",
  });
  let connections = 0;
  const info = {
    op: "serverInfo",
    name: "test bridge",
    sessionId,
    capabilities: ["clientPublish"],
    supportedEncodings: ["json"],
  };
  const advertisement = {
    op: "advertise",
    channels: ["/first", "/latest"].map((topic, index) => ({
      id: index + 1,
      topic,
      encoding: "json",
      schemaName: "test.Value",
      schema: "{}",
      schemaEncoding: "jsonschema",
    })),
  };
  server.on("connection", (socket) => {
    connections++;
    socket.on("error", () => {});
    socket.on("message", (data, binary) => {
      if (!binary) {
        received.push(JSON.parse(data));
      }
    });
    socket.send(JSON.stringify(info));
    socket.send(JSON.stringify(advertisement));
  });
  await once(server, "listening");
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(stop);
  return {
    server,
    received,
    stop,
    info,
    advertisement,
    get connections() {
      return connections;
    },
  };
}
function connect(url) {
  const socket = new WebSocket(url, ["foxglove.websocket.v1"], {
    origin: ORIGIN,
    handshakeTimeout: 2000,
  });
  const errors = [];
  socket.on("error", (error) => errors.push(error));
  const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  return { socket, errors, closed };
}

test("the launcher is ready and safely refuses an early client, then proxies fresh connections after bridge restarts", async (t) => {
  const port = await unusedPort();
  const { launcher, socketPath } = await startLauncher(t, {
    controlPlane: `ws://127.0.0.1:${port}`,
  });
  await launcher.waitForPort();
  assert.equal(
    (await rawCall(socketPath, "GET", "/v1/describe?wait_ready_ms=5000")).json.ready,
    true,
  );
  assert.equal((await fetch(launcher.base)).status, 200);
  const early = connect(`${launcher.base.replace("http:", "ws:")}/ws`);
  t.after(() => early.socket.terminate());
  assert.equal(await early.closed, 1006, "an upstream refusal ends the unsuccessful handshake");
  assert.match(early.errors[0].message, /502/);
  assert.equal(launcher.child.exitCode, null);
  const first = await bridge(t, port);
  const connected = connect(`${launcher.base.replace("http:", "ws:")}/ws`);
  t.after(() => connected.socket.terminate());
  await once(connected.socket, "open");
  await until(() => first.connections === 1);
  // A close frame, as well as abrupt peer loss, must end the downstream.
  [...first.server.clients][0].close(1001, "restarting");
  assert.equal(await connected.closed, 1001);
  await first.stop();
  const refused = connect(`${launcher.base.replace("http:", "ws:")}/ws`);
  t.after(() => refused.socket.terminate());
  await refused.closed;
  const restarted = await bridge(t, port, "restarted");
  const fresh = connect(`${launcher.base.replace("http:", "ws:")}/ws`);
  t.after(() => fresh.socket.terminate());
  await once(fresh.socket, "open");
  fresh.socket.send(JSON.stringify({ op: "subscribe", subscriptions: [{ id: 1, channelId: 2 }] }));
  await until(() => restarted.received.length === 1);
  assert.equal(restarted.connections, 1);
  assert.equal(restarted.received[0].op, "subscribe");
  await restarted.stop();
  assert.equal(await fresh.closed, 1011, "abrupt upstream loss becomes a downstream close frame");
  assert.equal((await launcher.control()).described.ready, true);
  assert.equal(launcher.errors, "");
});

function assertConnectionFailedAlert(alerts, url) {
  const failed = (alerts ?? []).filter((alert) => alert.message === "Connection failed");
  assert.equal(
    failed.length,
    1,
    "the unchanged Connection failed alert is shown during the outage",
  );
  assert.equal(failed[0].severity, "error");
  assert.ok(
    failed[0].tip.startsWith(
      `Check that the WebSocket server at ${url} is reachable and supports protocol version one of: `,
    ),
  );
}

for (const workers of [true, false]) {
  test(`the page retries a late bridge and replays only the latest desired revision once per new connection (${workers ? "worker" : "native"} socket)`, async (t) => {
    const port = await unusedPort();
    const { launcher } = await startLauncher(t, { controlPlane: `ws://127.0.0.1:${port}` });
    await launcher.waitForPort();
    const logs = [];
    const logger = Object.fromEntries(
      ["info", "warn", "error", "debug"].map((level) => [
        level,
        (...args) => logs.push({ level, args }),
      ]),
    );
    const harness = playerHarness({
      url: `${launcher.base.replace("http:", "ws:")}/ws`,
      workers,
      logger,
    });
    t.after(() => harness.stop());
    harness.player.setSubscriptions([{ topic: "/first" }]);
    harness.player.setPublishers([{ topic: "/publish-first", schemaName: "test.Value" }]);
    await until(() => harness.stats.latest?.presence === "RECONNECTING");
    assertConnectionFailedAlert(
      harness.stats.latest.alerts,
      `${launcher.base.replace("http:", "ws:")}/ws`,
    );
    const first = await bridge(t, port);
    await until(
      () => first.received.length === 2,
      5000,
      () =>
        JSON.stringify({
          presence: harness.stats.latest?.presence,
          attempts: harness.stats.attempts,
          activeWorkers: harness.stats.activeWorkers,
          bridgeConnections: first.connections,
          bridgeMessages: first.received.length,
          launcherErrors: launcher.errors.slice(-400),
          logs: logs
            .slice(-6)
            .map((entry) => `${entry.level}: ${entry.args.map(String).join(" ").slice(0, 160)}`),
        }),
    );
    assert.equal(harness.stats.latest.presence, "PRESENT");
    assert.ok(
      !(harness.stats.latest.alerts ?? []).some((alert) => alert.message === "Connection failed"),
      "the alert clears once connected",
    );
    assert.equal(first.connections, 1);
    await first.stop();
    await until(() => harness.stats.latest?.presence === "RECONNECTING");
    harness.player.setSubscriptions([{ topic: "/latest" }]);
    harness.player.setPublishers([{ topic: "/publish-latest", schemaName: "test.Value" }]);
    const restarted = await bridge(t, port, "restarted");
    await until(() => restarted.received.length === 2);
    assert.equal(restarted.connections, 1);
    assert.equal(
      restarted.received.find((message) => message.op === "subscribe").subscriptions[0].channelId,
      2,
    );
    assert.equal(
      restarted.received.find((message) => message.op === "advertise").channels[0].topic,
      "/publish-latest",
    );
    const peer = [...restarted.server.clients][0];
    peer.send(JSON.stringify(restarted.info));
    peer.send(JSON.stringify(restarted.advertisement));
    harness.player.setSubscriptions([{ topic: "/latest" }]);
    harness.player.setPublishers([{ topic: "/publish-latest", schemaName: "test.Value" }]);
    await delay(150);
    assert.equal(restarted.received.length, 2, "the same applied revision is not replayed again");
    assert.ok(harness.stats.maximumWorkers <= 1, "one attempt in flight");
    assert.deepEqual(
      logs.map((entry) => entry.level),
      ["error", "warn", "error"],
      "each outage logs its alert once and short outages share one ten-second summary",
    );
    for (const entry of [logs[0], logs[2]]) {
      assert.deepEqual(entry.args.slice(0, 2).map(String), [
        "Player alert",
        "ws:connection-failed",
      ]);
    }
    await harness.stop();
    const attempts = harness.stats.attempts;
    await delay(300);
    assert.equal(harness.stats.attempts, attempts, "closing the page cancels reconnects");
    assert.equal(harness.stats.activeWorkers, 0);
  });
}

test("constructor and worker failures release the worker and feed the same reconnect path", async (t) => {
  const port = await unusedPort();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const harness = playerHarness({ url: `ws://127.0.0.1:${port}`, workers: false, logger });
  t.after(() => harness.stop());
  const frames = [];
  let thrown = 0;
  harness.context.self = { postMessage: (frame) => frames.push(frame) };
  harness.context.WebSocket = class {
    constructor() {
      thrown++;
      throw new Error("connection construction failed");
    }
  };
  harness.load(path.join(PLAYER, "worker.ts"));
  harness.context.self.onmessage({
    data: { type: "open", data: { wsUrl: `ws://127.0.0.1:${port}` } },
  });
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["error", "close"],
  );
  assert.equal(frames[1].data.code, 1006);
  await until(() => thrown >= 2);
  assert.equal(
    harness.stats.latest.presence,
    "RECONNECTING",
    "a direct constructor failure also retries",
  );
  assertConnectionFailedAlert(harness.stats.latest.alerts, `ws://127.0.0.1:${port}`);
  let worker,
    terminated = 0,
    errors = 0,
    closed = 0;
  harness.context.Worker = class {
    constructor() {
      worker = this;
    }
    postMessage() {}
    terminate() {
      terminated++;
    }
  };
  const Adapter = harness.load(path.join(PLAYER, "WorkerSocketAdapter.ts")).default;
  const adapter = new Adapter(`ws://127.0.0.1:${port}`);
  adapter.onerror = () => errors++;
  adapter.onclose = () => closed++;
  worker.onerror(new Error("worker failed"));
  worker.onerror(new Error("late worker error"));
  worker.onmessage({ data: { type: "close", data: {} } });
  adapter.close();
  assert.equal(terminated, 1);
  assert.equal(errors, 1);
  assert.equal(closed, 1);
});

test("the reconnect decision uses full jitter, exponential growth and a bounded cap", async () => {
  const source = fs.readFileSync(path.join(PLAYER, "reconnect.ts"), "utf8");
  const { stripTypeScriptTypes } = require("node:module");
  const { reconnectDelay } = await import(
    `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`
  );
  assert.deepEqual(
    Array.from({ length: 10 }, (_, attempt) => reconnectDelay(attempt, 0.5)),
    [125, 250, 500, 1000, 2000, 4000, 8000, 15000, 15000, 15000],
  );
  assert.equal(reconnectDelay(100_000, 0.999), 29970);
  assert.equal(reconnectDelay(100_000, 0), 0);
  for (let attempt = 0; attempt < 12; attempt++) {
    for (const jitter of [0, 0.1, 0.25, 0.75, 0.999]) {
      assert.equal(
        reconnectDelay(attempt, jitter),
        Math.floor(jitter * Math.min(30000, 250 * 2 ** attempt)),
      );
    }
  }
});

function processResources(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
  return {
    cpu: (Number(stat[11]) + Number(stat[12])) / ticks,
    threads: fs.readdirSync(`/proc/${pid}/task`).length,
    fds: fs.readdirSync(`/proc/${pid}/fd`).length,
  };
}
function childCall(child, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", answer);
      reject(new Error(`child ${message} timed out`));
    }, timeoutMs);
    const answer = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    child.once("message", answer);
    child.send(message);
  });
}

test("[long] a bridge down for sixty seconds stays idle and bounded, then recovers with one replay", {
  skip: process.env.XGC2_RECONNECT_LONG_TEST !== "1",
  timeout: 95000,
}, async (t) => {
  const port = await unusedPort();
  const { launcher } = await startLauncher(t, { controlPlane: `ws://127.0.0.1:${port}` });
  await launcher.waitForPort();
  const child = fork(
    path.join(__dirname, "player_reconnect_fixture.cjs"),
    [`${launcher.base.replace("http:", "ws:")}/ws`],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    if (child.connected) {
      child.send("stop");
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  });
  await once(child, "message");
  let stats;
  do {
    await delay(20);
    stats = await childCall(child, "snapshot");
  } while (stats.activeWorkers !== 0 || stats.latest?.presence !== "RECONNECTING");
  const before = {
    page: processResources(child.pid),
    launcher: processResources(launcher.child.pid),
  };
  const started = Date.now();
  await delay(60000);
  const wallMs = Date.now() - started;
  stats = await childCall(child, "snapshot");
  const after = {
    page: processResources(child.pid),
    launcher: processResources(launcher.child.pid),
  };
  assert.ok(wallMs >= 60000);
  for (const name of ["page", "launcher"]) {
    assert.ok(
      after[name].cpu - before[name].cpu < 1.2,
      `${name} CPU below two percent of one core`,
    );
    assert.ok(after[name].threads <= before[name].threads, `${name} threads do not grow`);
    assert.ok(after[name].fds <= before[name].fds, `${name} open fds do not grow`);
  }
  assert.ok(stats.attempts <= 15, `bounded attempts: ${stats.attempts}`);
  assert.ok(stats.maximumWorkers <= 1);
  const blocks = errors
    .trim()
    .split(/\n(?=[^\s}])/)
    .filter(Boolean);
  const alertBlocks = blocks.filter((block) =>
    block.startsWith("Player alert ws:connection-failed"),
  );
  const lines = blocks.filter((block) => !block.startsWith("Player alert ws:connection-failed"));
  assert.equal(
    alertBlocks.length,
    1,
    "the Connection failed alert is logged once for the whole outage",
  );
  assert.ok(lines.length <= 7, `bounded outage logs: ${lines.length}`);
  assert.ok(
    lines.every((line) => line.includes("suppressed failures")),
    errors,
  );
  assert.equal(output, "");
  assert.equal(launcher.errors, "", "the proxy does not log every refused upstream attempt");
  await childCall(child, "latest");
  const restarted = await bridge(t, port, "after-long-outage");
  await until(
    () => restarted.received.length === 2,
    32000,
    () =>
      JSON.stringify({
        bridgeConnections: restarted.connections,
        bridgeMessages: restarted.received.length,
        childOutput: output.slice(-300),
        childErrors: errors.slice(-600),
        launcherErrors: launcher.errors.slice(-400),
      }),
  );
  assert.equal(restarted.connections, 1);
  assert.equal(
    restarted.received.find((message) => message.op === "subscribe").subscriptions[0].channelId,
    2,
  );
  assert.equal(
    restarted.received.find((message) => message.op === "advertise").channels[0].topic,
    "/publish-latest",
  );
  await delay(250);
  assert.equal(restarted.received.length, 2);
  t.diagnostic(
    JSON.stringify({ wallMs, attempts: stats.attempts, logLines: lines.length, before, after }),
  );
  await restarted.stop();
  const next = await bridge(t, port, "after-recovery");
  await until(() => next.received.length === 2, 1000);
  assert.equal(
    next.connections,
    1,
    "success resets the capped outage backoff before the next restart",
  );
  child.send("stop");
  assert.equal(await exited, 0);
  await next.stop();
});
