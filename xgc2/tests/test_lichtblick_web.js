// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { startLauncher } = require("./launcher_fixture.cjs");

process.env.XGC2_LICHTBLICK_WEB_STATIC_ROOT = "/tmp/unused";
process.env.XGC2_LICHTBLICK_WEB_ENV_FILE = "/tmp/unused.env";

const {
  buildAutoConnectScript,
  createIndexLoader,
  defaultListenerOrigins,
  endpointMatches,
  normalizeOrigin,
  normalizeAssetUrlPrefix,
  staticCacheControl,
  notModifiedSince,
  parseArgs,
  parseConfiguredOrigins,
  parseWsUrl,
  safeJoin,
  securityHeaders,
  transformIndexHtml,
  validateFrameAncestors,
  websocketOriginAllowed,
} = require("../launcher/xgc2-lichtblick-web.js");

test("parses the browser server command line", () => {
  assert.deepEqual(
    parseArgs([
      "--host",
      "0.0.0.0",
      "--port",
      "9090",
      "--control-plane-url",
      "wss://robot.example/bridge",
      "--public-url-prefix",
      "/lichtblick",
      "--allowed-origin",
      "https://xgc.example",
      "--allowed-origin",
      "http://127.0.0.1:5173",
      "--frame-ancestors",
      "'self' https://xgc.example",
    ]),
    {
      host: "0.0.0.0",
      port: 9090,
      controlPlaneUrl: "wss://robot.example/bridge",
      publicUrlPrefix: "/lichtblick",
      allowedOrigins: ["https://xgc.example", "http://127.0.0.1:5173"],
      frameAncestors: "'self' https://xgc.example",
      assetUrlPrefix: null,
      startupInput: null,
      controlSocket: null,
      shutdownMs: null,
      showHelp: false,
      layoutStdin: false,
    },
  );
});

test("parses the startup input and the control socket exactly once each", () => {
  assert.deepEqual(
    {
      ...parseArgs([
        "--startup-input",
        "/run/xgc2/input.json",
        "--control-socket",
        "/run/xgc2/sockets/lichtblick.sock",
      ]),
    },
    {
      host: null,
      port: null,
      controlPlaneUrl: null,
      publicUrlPrefix: null,
      allowedOrigins: [],
      frameAncestors: null,
      assetUrlPrefix: null,
      startupInput: "/run/xgc2/input.json",
      controlSocket: "/run/xgc2/sockets/lichtblick.sock",
      shutdownMs: null,
      showHelp: false,
      layoutStdin: false,
    },
  );
  for (const argv of [
    ["--startup-input", "a", "--startup-input", "b"],
    ["--control-socket", "a", "--control-socket", "b"],
    ["--startup-input"],
    ["--control-socket", "--port"],
    ["--startup-input", "--control-socket", "x"],
  ]) {
    assert.throws(() => parseArgs(argv), /explicit --(startup-input|control-socket)/);
  }
});

test("the drain budget is a bounded millisecond count", () => {
  assert.equal(parseArgs(["--shutdown-ms", "250"]).shutdownMs, 250);
  for (const value of ["0", "60001", "-5", "1.5", "fast", ""]) {
    assert.throws(() => parseArgs(["--shutdown-ms", value]), /invalid --shutdown-ms/);
  }
});

test("the retired bootstrap input and per-launch TLS options are gone", () => {
  for (const flag of ["--bootstrap-input", "--tls-cert", "--rpc-token"]) {
    assert.throws(() => parseArgs([flag, "value"]), /unknown option/);
  }
});

test("rejects the retired XGC layout flags", () => {
  // Layout is prepared once by the owning product and passed as a single document.
  for (const flag of [
    "--initial-view",
    "--ar-visible",
    "--grid-visible",
    "--grid-color",
    "--grid-size",
    "--grid-divisions",
    "--grid-line-width",
  ]) {
    assert.throws(() => parseArgs([flag, "value"]), /unknown option/);
  }
});

test("normalizes exact HTTP origins and rejects ambiguous sources", () => {
  assert.equal(
    normalizeOrigin("https://xgc.example:443"),
    "https://xgc.example",
  );
  assert.equal(
    normalizeOrigin("http://127.0.0.1:8080"),
    "http://127.0.0.1:8080",
  );
  assert.throws(
    () => normalizeOrigin("ws://xgc.example"),
    /must use http:[/][/]/,
  );
  assert.throws(
    () => normalizeOrigin("https://xgc.example/path"),
    /must not include/,
  );
  assert.throws(() => normalizeOrigin("https://*.example"), /wildcard/);
});

test("builds the WebSocket browser Origin allowlist", () => {
  const origins = new Set([
    ...defaultListenerOrigins(8080),
    ...parseConfiguredOrigins([
      "http://127.0.0.1:5173, http://localhost:5173",
      "https://xgc.example",
    ]),
  ]);
  assert.equal(websocketOriginAllowed("http://127.0.0.1:8080", origins), true);
  assert.equal(websocketOriginAllowed("http://localhost:5173", origins), true);
  assert.equal(websocketOriginAllowed("https://xgc.example", origins), true);
  assert.equal(websocketOriginAllowed("https://evil.example", origins), false);
  assert.equal(websocketOriginAllowed(undefined, origins), false);
});

test("validates an iframe-compatible frame-ancestors policy", () => {
  assert.equal(
    validateFrameAncestors(
      "'self' https://xgc.example:443 http://127.0.0.1:5173",
    ),
    "'self' https://xgc.example http://127.0.0.1:5173",
  );
  assert.equal(validateFrameAncestors("'none'"), "'none'");
  assert.throws(
    () => validateFrameAncestors("'none' https://xgc.example"),
    /cannot be combined/,
  );
  assert.throws(
    () => validateFrameAncestors("'self'; default-src *"),
    /invalid separator/,
  );
  assert.equal(
    securityHeaders("'self' https://xgc.example")["Content-Security-Policy"],
    "frame-ancestors 'self' https://xgc.example; base-uri 'self'; object-src 'none'",
  );
});

test("matches root and public-prefix runtime endpoints", () => {
  assert.equal(endpointMatches("/version", "/lichtblick", "version"), true);
  assert.equal(
    endpointMatches("/lichtblick/version?full=1", "/lichtblick", "version"),
    true,
  );
  assert.equal(
    endpointMatches("/other/version", "/lichtblick", "version"),
    false,
  );
});

test("validates websocket upstream URLs", () => {
  assert.deepEqual(parseWsUrl("wss://robot.example/bridge?token=1"), {
    protocol: "wss:",
    hostname: "robot.example",
    port: 443,
    path: "/bridge?token=1",
  });
  assert.throws(
    () => parseWsUrl("http://robot.example"),
    /must use ws:\/\/ or wss:\/\//,
  );
});

test("keeps static paths inside the web root", () => {
  assert.equal(
    safeJoin("/srv/web", "/assets/app.js"),
    "/srv/web/assets/app.js",
  );
  assert.equal(safeJoin("/srv/web", "/../etc/passwd"), null);
  assert.equal(safeJoin("/srv/web", "/%2e%2e/etc/passwd"), null);
});

test("leaves upstream layout ownership untouched and injects same-origin auto-connect", () => {
  const source = `<!doctype html><html><head></head><script>
globalThis.LICHTBLICK_SUITE_DEFAULT_LAYOUT = [/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/][0];
</script><body></body></html>`;
  const transformed = transformIndexHtml(source, "/lichtblick");

  assert.match(transformed, /LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER/);
  assert.match(transformed, /foxglove-websocket/);
  assert.match(transformed, /\/lichtblick\/ws/);
});

test("does not replace an explicit data source", () => {
  const script = buildAutoConnectScript("/");
  assert.match(script, /searchParams\.has\("ds"\)/);
  assert.match(script, /history\.replaceState/);
});

test("reloads index.html after the webpack hash changes", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "xgc2-lichtblick-index-"),
  );
  const indexPath = path.join(temporary, "index.html");
  fs.writeFileSync(
    indexPath,
    '<html><head></head><script src="main.old.js"></script></html>',
  );
  const loadIndex = createIndexLoader("/", temporary);
  assert.match(loadIndex(), /main\.old\.js/);
  const later = new Date(Date.now() + 2000);
  fs.writeFileSync(
    indexPath,
    '<html><head></head><script src="main.new.js"></script></html>',
  );
  fs.utimesSync(indexPath, later, later);
  assert.match(loadIndex(), /main\.new\.js/);
  fs.rmSync(temporary, { recursive: true, force: true });
});

for (const withLayout of [false, true]) {
  test(`serves source metadata and prepared layout=${withLayout} with WebSocket Origin`, async (t) => {
    const layout = {
      configById: { scene: { title: "</script><>&\u2028\u2029" } },
      layout: "scene",
    };
    const upstream = net.createServer((socket) => {
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk.toString("latin1");
        if (!request.includes("\r\n\r\n")) {
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " +
            crypto
              .createHash("sha1")
              .update(
                /sec-websocket-key:\s*([^\r\n]+)/i.exec(request)[1].trim() +
                  "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
              )
              .digest("base64") +
            "\r\n\r\n",
        );
      });
    });
    await listen(upstream);
    t.after(() => closeServer(upstream));
    const upstreamPort = upstream.address().port;
    const { launcher, web, buildInfo: buildInfoFile } = await startLauncher(t, {
      stdin: withLayout ? JSON.stringify(layout) : undefined,
      layoutStdin: withLayout,
      controlPlane: `ws://127.0.0.1:${upstreamPort}`,
      frameAncestors: "'self' http://127.0.0.1:5173",
      allowedOrigins: ["http://127.0.0.1:5173"],
      prepare: ({ web: webRoot }) => {
        fs.writeFileSync(
          path.join(webRoot, "index.html"),
          "<!doctype html><html><head></head><script>" +
            "globalThis.LICHTBLICK_SUITE_DEFAULT_LAYOUT = " +
            "[/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/][0];" +
            "</script><body></body></html>",
        );
        fs.writeFileSync(
          path.join(webRoot, "main.3f1c2a9b8d7e6f5a4b3c.js"),
          "// bundle",
        );
        fs.writeFileSync(path.join(webRoot, "favicon.ico"), "icon");
      },
    });
    const webRoot = web;
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoFile, "utf8"));

    const port = await launcher.waitForPort();
    const version = await getJson(port, "/version");
    assert.deepEqual(version.body, buildInfo);
    assert.equal(
      version.headers["content-security-policy"],
      "frame-ancestors 'self' http://127.0.0.1:5173; base-uri 'self'; object-src 'none'",
    );
    assert.equal(version.headers["x-frame-options"], undefined);

    const legacyLayout = await getText(port, "/xgc2-layout.json");
    assert.equal(legacyLayout.statusCode, 404);
    const index = await getText(port, "/");
    if (withLayout) {
      assert.doesNotMatch(
        index.body,
        /LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER/,
      );
      assert.match(index.body, /\\u003c\\u002f?script|\\u003c/);
      assert.ok(!index.body.includes(layout.configById.scene.title));
      const injected =
        /globalThis\.LICHTBLICK_SUITE_DEFAULT_LAYOUT = \[(.*?)\]\[0\];/s.exec(
          index.body,
        )[1];
      assert.deepEqual(JSON.parse(injected), layout);
      assert.deepEqual((await getJson(port, "/layout.json")).body, layout);
    } else {
      assert.match(index.body, /LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER/);
      assert.equal((await getText(port, "/layout.json")).statusCode, 404);
    }
    assert.match(index.body, /foxglove-websocket/);

    const bundle = await getText(port, "/main.3f1c2a9b8d7e6f5a4b3c.js");
    assert.equal(bundle.statusCode, 200);
    assert.equal(
      bundle.headers["cache-control"],
      "public, max-age=31536000, immutable",
    );
    const favicon = await getText(port, "/favicon.ico");
    assert.equal(favicon.headers["cache-control"], "no-cache");
    const revalidated = await getText(port, "/favicon.ico", {
      "If-Modified-Since": favicon.headers["last-modified"],
    });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.body, "");

    await t.test(
      "retries a missing or partial index without serving stale HTML",
      async () => {
        const indexPath = path.join(webRoot, "index.html");
        const original = fs.readFileSync(indexPath, "utf8");
        let revision = Date.now();
        const replaceIndex = (html) => {
          fs.writeFileSync(indexPath, html);
          const modified = new Date((revision += 2000));
          fs.utimesSync(indexPath, modified, modified);
        };

        for (const state of ["missing", "partial"]) {
          if (state === "missing") {
            fs.unlinkSync(indexPath);
          } else {
            replaceIndex("<!doctype html><html><head>");
          }
          for (const requestPath of ["/", "/index.html", "/workspace"]) {
            const unavailable = await getText(port, requestPath);
            assert.equal(unavailable.statusCode, 503);
            assert.equal(unavailable.headers["cache-control"], "no-store");
            assert.equal(unavailable.headers["retry-after"], "1");
            assert.equal(
              unavailable.headers["content-security-policy"],
              index.headers["content-security-policy"],
            );
            assert.doesNotMatch(
              unavailable.body,
              /LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER/,
            );
          }

          replaceIndex(
            original.replace("</body>", `<p>${state} recovered</p></body>`),
          );
          const recovered = await getText(port, "/");
          assert.equal(recovered.statusCode, 200);
          assert.match(recovered.body, new RegExp(`${state} recovered`));
          assert.match(recovered.body, /foxglove-websocket/);
        }
      },
    );

    assert.match(
      await websocketUpgradeStatus(port, "https://evil.example"),
      /^HTTP\/1\.1 403/,
    );
    assert.match(
      await websocketUpgradeStatus(port, `http://127.0.0.1:${port}`),
      /^HTTP\/1\.1 101/,
    );
    assert.match(
      await websocketUpgradeStatus(port, "http://127.0.0.1:5173"),
      /^HTTP\/1\.1 101/,
    );
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve({ body: JSON.parse(body), headers: response.headers });
          } catch (error) {
            reject(error);
          }
        });
      })
      .once("error", reject);
  });
}

function getText(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: requestPath, headers },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode,
              body,
              headers: response.headers,
            }),
          );
        },
      )
      .once("error", reject);
  });
}

function websocketUpgradeStatus(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for WebSocket upgrade response"));
    }, 3000);
    socket.once("connect", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${origin}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) {
        return;
      }
      clearTimeout(timeout);
      socket.destroy();
      resolve(response.split("\r\n", 1)[0]);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("loads content-hashed entry scripts from a stable asset prefix only when asked", () => {
  const index =
    "<!doctype html><html><head>" +
    '<link rel="icon" href="favicon-32x32.png" />' +
    '<script defer="defer" src="main.3f1c2a9b8d7e6f5a4b3c.js"></script>' +
    '<script defer src="./vendor.0a1b2c3d4e5f60718293.js"></script>' +
    '<script src="https://cdn.example/x.0a1b2c3d4e5f60718293.js"></script>' +
    '<script src="plain.js"></script>' +
    "</head><body></body></html>";
  assert.equal(
    transformIndexHtml(index, "/"),
    transformIndexHtml(index, "/", null),
  );
  assert.doesNotMatch(transformIndexHtml(index, "/"), /lichtblick-assets/);

  const staged = transformIndexHtml(
    index,
    "/",
    "/api/visualization/lichtblick-assets",
  );
  assert.match(
    staged,
    /src="\/api\/visualization\/lichtblick-assets\/main\.3f1c2a9b8d7e6f5a4b3c\.js"/,
  );
  assert.match(
    staged,
    /src="\/api\/visualization\/lichtblick-assets\/vendor\.0a1b2c3d4e5f60718293\.js"/,
  );
  assert.match(
    staged,
    /src="https:\/\/cdn\.example\/x\.0a1b2c3d4e5f60718293\.js"/,
  );
  assert.match(staged, /src="plain\.js"/);
  assert.match(staged, /href="favicon-32x32\.png"/);
  assert.match(staged, /foxglove-websocket/);

  assert.throws(
    () =>
      transformIndexHtml(
        '<head><script src="plain.js"></script></head>',
        "/",
        "/assets/",
      ),
    /no content-hashed script/,
  );
});

test("accepts only same-origin absolute asset prefixes", () => {
  assert.equal(normalizeAssetUrlPrefix("/assets"), "/assets/");
  assert.equal(normalizeAssetUrlPrefix("/a/b-c_d.e/"), "/a/b-c_d.e/");
  for (const value of [
    "assets",
    "//evil.example/",
    "https://evil.example/",
    "/a/../b",
    "/a/./b",
    "/a b",
    "/a?x",
    "/a#x",
    '/a"',
    "",
  ]) {
    assert.throws(
      () => normalizeAssetUrlPrefix(value),
      /invalid asset URL prefix/,
      value,
    );
  }
});

test("caches content-hashed bundles for good and revalidates everything else", () => {
  const immutable = "public, max-age=31536000, immutable";
  assert.equal(
    staticCacheControl("/web/main.3f1c2a9b8d7e6f5a4b3c.js"),
    immutable,
  );
  assert.equal(
    staticCacheControl("/web/412.3f1c2a9b8d7e6f5a4b3c.js"),
    immutable,
  );
  assert.equal(
    staticCacheControl("/web/main.3f1c2a9b8d7e6f5a4b3c.js.map"),
    immutable,
  );
  assert.equal(
    staticCacheControl("/web/Worker.worker.3f1c2a9b8d7e6f5a4b3c.js"),
    immutable,
  );
  assert.equal(staticCacheControl("/web/3f1c2a9b8d7e6f5a4b3c.glb"), immutable);
  assert.equal(staticCacheControl("/web/favicon.ico"), "no-cache");
  assert.equal(staticCacheControl("/web/main.js"), "no-cache");
  assert.equal(staticCacheControl("/web/index.html"), "no-cache");
  assert.equal(
    staticCacheControl("/web/3f1c2a9b8d7e6f5a4b3c.html"),
    "no-cache",
  );
});

test("answers conditional requests at HTTP date precision", () => {
  const mtime = new Date("2026-09-24T10:00:00.750Z");
  assert.equal(notModifiedSince(mtime.toUTCString(), mtime), true);
  assert.equal(notModifiedSince("Thu, 24 Sep 2026 09:59:59 GMT", mtime), false);
  assert.equal(notModifiedSince("not a date", mtime), false);
  assert.equal(notModifiedSince(undefined, mtime), false);
});
