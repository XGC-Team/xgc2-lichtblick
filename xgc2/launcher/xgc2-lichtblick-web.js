#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
//
// xgc2-lichtblick-web launcher
//
// Serves the Web bundle built from this source tree
// on a local HTTP port and reverse-proxies WebSocket connections on
// /lichtblick/ws (and /ws as a fallback) to a configurable upstream.
//
// Default upstream: ws://127.0.0.1:8765 (XGC2 Robot Control Plane).
// Override per-launch with --control-plane-url, or per-machine by setting
// CONTROL_PLANE_URL in xgc2/launcher/lichtblick-web.env.
//
// HTTP lifecycle and WebSocket transport are provided by @xgc2/xrpc. The domain
// service `xgc2.lichtblick.v1` listens on a private Unix socket named by
// --control-socket; browsers only ever reach the same-origin gateway.

"use strict";

const fs = require("node:fs");
const { createHTTPHost, proxyWebSocket, Diagnostics } = require("@xgc2/xrpc");
const path = require("node:path");
const url = require("node:url");
const {
  MAX_WIRE_BYTES,
  MAX_ASSET_BYTES,
  SHUTDOWN_MS,
  PersistenceError,
  createManagedDomainClientFromInput,
} = require("./managed-storage.cjs");
const { createControlService } = require("./control-service.cjs");
const { loadStartupInput, checkUnixAddress } = require("./startup-input.cjs");
const { readJSONInput } = require("./prepare-layout.cjs");
const { ViewStore, rejectViewFamily } = require("./view-state.cjs");
const { createViewGateway } = require("./view-gateway.cjs");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_CONTROL_PLANE_URL = "ws://127.0.0.1:8765";
const DEFAULT_PUBLIC_URL_PREFIX = "/";
// 'self' covers production same-origin proxying; the loopback pairs are the
// XGC2 station ports (Vite dev 5173/5174, Core 8787/8788) whose 127.0.0.1 and
// localhost aliases are different sites to the browser — the viewer iframe may
// be served from either alias of the pair the operator's browser is not on.
const DEFAULT_FRAME_ANCESTORS =
  "'self' http://127.0.0.1:5173 http://localhost:5173 http://127.0.0.1:5174 http://localhost:5174 http://127.0.0.1:8787 http://localhost:8787 http://127.0.0.1:8788 http://localhost:8788";
const ENV_FILE =
  process.env.XGC2_LICHTBLICK_WEB_ENV_FILE ??
  path.join(__dirname, "lichtblick-web.env");
const DEFAULT_STATIC_ROOT = path.resolve(__dirname, "../../web/.webpack");
const DEFAULT_BUILD_INFO_FILE = path.resolve(
  __dirname,
  "../../web/build-info.json",
);
// Both paths remain overridable for tests and process-supervisor staging.
const STATIC_ROOT =
  process.env.XGC2_LICHTBLICK_WEB_STATIC_ROOT ?? DEFAULT_STATIC_ROOT;
const BUILD_INFO_FILE =
  process.env.XGC2_LICHTBLICK_WEB_BUILD_INFO ?? DEFAULT_BUILD_INFO_FILE;
const LOG_PREFIX = "xgc2-lichtblick-web";

function logLine(level, message) {
  const ts = new Date().toISOString();
  process.stdout.write(`${ts} ${level.padEnd(5)} ${LOG_PREFIX}: ${message}\n`);
}

function logInfo(message) {
  logLine("info", message);
}
function logWarn(message) {
  logLine("warn", message);
}
function logError(message) {
  logLine("error", message);
}

// ---- Argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    host: null,
    port: null,
    controlPlaneUrl: null,
    publicUrlPrefix: null,
    allowedOrigins: [],
    frameAncestors: null,
    assetUrlPrefix: null,
    startupInput: null,
    controlSocket: null,
    shutdownMs: null,
    showHelp: false,
    layoutStdin: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--layout-stdin":
        if (opts.layoutStdin)
          throw new Error("--layout-stdin occurs more than once");
        opts.layoutStdin = true;
        break;
      case "-h":
      case "--help":
        opts.showHelp = true;
        break;
      case "--host":
        opts.host = argv[++i];
        break;
      case "--port":
        opts.port = Number.parseInt(argv[++i], 10);
        if (
          !Number.isInteger(opts.port) ||
          opts.port < 0 ||
          opts.port > 65535
        ) {
          throw new Error(`invalid --port value: ${argv[i]}`);
        }
        break;
      case "--control-plane-url":
        opts.controlPlaneUrl = argv[++i];
        break;
      case "--public-url-prefix":
        opts.publicUrlPrefix = argv[++i];
        break;
      case "--allowed-origin":
        opts.allowedOrigins.push(argv[++i]);
        break;
      case "--frame-ancestors":
        opts.frameAncestors = argv[++i];
        break;
      case "--asset-url-prefix":
        opts.assetUrlPrefix = argv[++i];
        break;
      case "--startup-input":
        if (
          opts.startupInput != null ||
          !argv[i + 1] ||
          argv[i + 1].startsWith("--")
        )
          throw new Error("one explicit --startup-input file is required");
        opts.startupInput = argv[++i];
        break;
      case "--shutdown-ms":
        opts.shutdownMs = Number.parseInt(argv[++i], 10);
        if (
          !/^[1-9][0-9]{0,4}$/.test(argv[i] ?? "") ||
          opts.shutdownMs > 60000
        ) {
          throw new Error(`invalid --shutdown-ms value: ${argv[i]}`);
        }
        break;
      case "--control-socket":
        if (
          opts.controlSocket != null ||
          !argv[i + 1] ||
          argv[i + 1].startsWith("--")
        )
          throw new Error("one explicit --control-socket path is required");
        opts.controlSocket = argv[++i];
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown option: ${arg}`);
        }
        throw new Error(`unexpected positional argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      `Usage: ${LOG_PREFIX} [options]`,
      "",
      "Serves the pinned Lichtblick web bundle on a local HTTP port and",
      "reverse-proxies WebSocket traffic to a configurable upstream.",
      "",
      "Options:",
      "  --host <ip|hostname>           Bind address. Env: HOST.",
      `                                   Default: ${DEFAULT_HOST}`,
      `  --port <port>                  TCP port. Env: PORT.`,
      `                                   Default: ${DEFAULT_PORT}`,
      `  --control-plane-url <wsurl>    WebSocket upstream. Env: CONTROL_PLANE_URL.`,
      `                                   Default: ${DEFAULT_CONTROL_PLANE_URL}`,
      "  --public-url-prefix <path>     URL prefix the bundle is served under.",
      "                                   Env: PUBLIC_URL_PREFIX.",
      `                                   Default: ${DEFAULT_PUBLIC_URL_PREFIX}`,
      "  --allowed-origin <origin>      Additional WebSocket browser origin.",
      "                                   May be repeated. Env: ALLOWED_ORIGINS (CSV).",
      "  --frame-ancestors <sources>    CSP frame-ancestors source list.",
      "                                   Env: FRAME_ANCESTORS.",
      `                                   Default: ${DEFAULT_FRAME_ANCESTORS}`,
      "  --asset-url-prefix <path>      Stable same-origin hashed-asset path. Env: ASSET_URL_PREFIX.",
      "  --startup-input <file>         Required private input granted by the process owner:",
      "                                   storage reference, scope, credential and asset grant.",
      "  --control-socket <path>        Required absolute Unix socket path of the xgc2.lichtblick.v1",
      "                                   service, inside the owner's private runtime directory.",
      "  --shutdown-ms <ms>             How long a Stop waits for admitted work (1..60000).",
      `                                   Default: ${SHUTDOWN_MS}`,
      "  --layout-stdin                 Read the prepared initial LayoutData from stdin.",
      "  -h, --help                     Show this help and exit.",
      "",
      "Environment variables override compiled-in defaults but are themselves",
      `overridden by command-line flags. Settings in ${ENV_FILE} (KEY=VALUE`,
      "lines, one per line, comments with '#') are loaded first.",
      "",
    ].join("\n"),
  );
}

// ---- source-owned environment file loader ----------------------------------

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (err) {
    logWarn(`cannot read ${envPath}: ${err.message}`);
    return;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      logWarn(`ignoring malformed line in ${envPath}: ${rawLine}`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes (single or double).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Do not override an already-set process env (so the operator can
    // override the file from the shell).
    if (process.env[key] == undefined) {
      process.env[key] = value;
    }
  }
}

// ---- WebSocket target and access policy -----------------------------------

function parseWsUrl(rawUrl) {
  const parsed = new url.URL(rawUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `control-plane URL must use ws:// or wss://, got ${parsed.protocol}`,
    );
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "wss:"
        ? 443
        : 80,
    path: `${parsed.pathname || "/"}${parsed.search || ""}`,
  };
}

function normalizeOrigin(rawOrigin) {
  const value = String(rawOrigin ?? "").trim();
  if (value === "") {
    throw new Error("origin must not be empty");
  }
  const parsed = new url.URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `origin must use http:// or https://, got ${parsed.protocol}`,
    );
  }
  if (parsed.hostname.includes("*")) {
    throw new Error(`origin must not contain a wildcard hostname: ${value}`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `origin must not include credentials, path, query, or fragment: ${value}`,
    );
  }
  return parsed.origin;
}

function parseConfiguredOrigins(values) {
  const origins = new Set();
  for (const rawValue of values) {
    for (const item of String(rawValue ?? "").split(",")) {
      if (item.trim() !== "") {
        origins.add(normalizeOrigin(item));
      }
    }
  }
  return origins;
}

function defaultListenerOrigins(port) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

function validateFrameAncestors(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (value === "") {
    throw new Error("frame-ancestors must not be empty");
  }
  if (/[,;\r\n]/.test(value)) {
    throw new Error("frame-ancestors contains an invalid separator");
  }
  const sources = value.split(/\s+/);
  if (sources.includes("'none'") && sources.length !== 1) {
    throw new Error(
      "frame-ancestors 'none' cannot be combined with other sources",
    );
  }
  const normalized = sources.map((source) => {
    if (source === "'self'" || source === "'none'") {
      return source;
    }
    return normalizeOrigin(source);
  });
  return normalized.join(" ");
}

function websocketOriginAllowed(originHeader, allowedOrigins) {
  if (typeof originHeader !== "string" || originHeader.trim() === "") {
    return false;
  }
  try {
    return allowedOrigins.has(normalizeOrigin(originHeader));
  } catch {
    return false;
  }
}

// ---- Static file serving ---------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function safeJoin(root, requested) {
  // Decode, normalize, and ensure the result is inside root. Prevents
  // directory traversal (`../`) and absolute-path escapes.
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  // Strip a single leading slash so path.posix.normalize treats the
  // remainder as relative — every URL path starts with `/`, but we
  // always re-anchor against the absolute `root` below.
  const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  const normalized = path.posix.normalize(relative);
  // After normalize, a leading ".." means the caller tried to escape.
  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  const full = path.join(root, normalized);
  const resolvedRoot = path.resolve(root);
  const resolvedFull = path.resolve(full);
  if (
    resolvedFull !== resolvedRoot &&
    !resolvedFull.startsWith(resolvedRoot + path.sep)
  ) {
    return null;
  }
  return resolvedFull;
}

function buildAutoConnectScript(prefix) {
  const websocketPath = `${prefix === "/" ? "" : prefix}/ws`;
  return `<script>(function(){
    var current = new URL(window.location.href);
    if (!current.searchParams.has("ds")) {
      var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      current.searchParams.set("ds", "foxglove-websocket");
      current.searchParams.set("ds.url", protocol + "//" + window.location.host + ${JSON.stringify(websocketPath)});
      window.history.replaceState(null, "", current.href);
    }
  })();</script>`;
}

function transformIndexHtml(source, prefix, assetUrlPrefix = null) {
  const autoConnect = buildAutoConnectScript(prefix);
  if (!source.includes("</head>")) {
    throw new Error("Lichtblick index.html has no closing head element");
  }
  const connected = source.replace("</head>", `${autoConnect}</head>`);
  return assetUrlPrefix == null
    ? connected
    : rewriteHashedScripts(connected, assetUrlPrefix);
}

/**
 * A viewer page URL is scoped to its process instance, so without this every
 * new instance fetched and compiled the identical bundle under a new URL.
 * Only the address of an absolute, same-origin path is accepted: the scripts
 * must stay behind the embedding origin and its proxy.
 */
function normalizeAssetUrlPrefix(value) {
  if (
    typeof value !== "string" ||
    !/^\/[A-Za-z0-9._~\-/]*$/.test(value) ||
    value.startsWith("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`invalid asset URL prefix: ${JSON.stringify(value)}`);
  }
  return value.endsWith("/") ? value : `${value}/`;
}

const SCRIPT_SRC = /(<script\b[^>]*?\bsrc=)(["'])([^"'<>]*)\2/g;

/**
 * Loads the content-hashed entry scripts from the stable asset prefix. The
 * bundle's webpack publicPath is "auto", so chunks and workers follow the
 * entry script. Only content-hashed names move: they are the same bytes for
 * every instance of every build, so a shared path cannot serve a stale file.
 */
function rewriteHashedScripts(source, assetUrlPrefix) {
  const assetPrefix = normalizeAssetUrlPrefix(assetUrlPrefix);
  let rewritten = 0;
  const result = source.replace(SCRIPT_SRC, (tag, head, quote, src) => {
    const relative = src.replace(/^\.\//, "");
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(relative) ||
      relative.startsWith("/") ||
      relative.split("/").includes("..") ||
      !relative.endsWith(".js") ||
      !CONTENT_HASHED_NAME.test(path.posix.basename(relative))
    ) {
      return tag;
    }
    rewritten += 1;
    return `${head}${quote}${assetPrefix}${relative}${quote}`;
  });
  if (rewritten === 0) {
    throw new Error(
      "asset URL prefix is set but index.html loads no content-hashed script",
    );
  }
  return result;
}

function createIndexLoader(
  prefix,
  staticRoot = STATIC_ROOT,
  assetUrlPrefix = null,
) {
  const indexPath = path.join(staticRoot, "index.html");
  let mtimeNs = -1n;
  let body = "";
  return function loadTransformedIndex() {
    const st = fs.statSync(indexPath);
    const nextMtime = st.mtimeNs ?? BigInt(Math.round(st.mtimeMs * 1e6));
    if (nextMtime !== mtimeNs) {
      body = transformIndexHtml(
        fs.readFileSync(indexPath, "utf8"),
        prefix,
        assetUrlPrefix,
      );
      mtimeNs = nextMtime;
    }
    return body;
  };
}

function resolveTransformedIndex(transformedIndex) {
  return typeof transformedIndex === "function"
    ? transformedIndex()
    : transformedIndex;
}

function loadBuildInfo() {
  const parsed = JSON.parse(fs.readFileSync(BUILD_INFO_FILE, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed == null ||
    parsed.schema !== "xgc2.lichtblick-web.build.v1" ||
    typeof parsed.package !== "string" ||
    typeof parsed.version !== "string" ||
    typeof parsed.upstreamSha !== "string"
  ) {
    throw new Error(
      `${BUILD_INFO_FILE} is not valid XGC2 Lichtblick build metadata`,
    );
  }
  return parsed;
}

function securityHeaders(frameAncestors) {
  return {
    "Content-Security-Policy": `frame-ancestors ${frameAncestors}; base-uri 'self'; object-src 'none'`,
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function serveIndex(res, transformedIndex, responseSecurityHeaders) {
  let body;
  try {
    body = Buffer.from(resolveTransformedIndex(transformedIndex));
  } catch (error) {
    logWarn(`index.html is temporarily unavailable: ${error.message}`);
    res.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "1",
      ...responseSecurityHeaders,
    });
    res.end("Lichtblick is temporarily unavailable. Please retry.");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    ...responseSecurityHeaders,
  });
  res.end(body);
}

// Webpack names bundles, chunks, workers and emitted assets by content hash
// (`main.<hash>.js`, `<hash>.png`), so their bytes never change under a name
// and can be cached for good. Anything else (HTML, copied favicons) must be
// revalidated so an upgraded package is never served stale; Last-Modified
// lets that revalidation answer 304 instead of resending the file.
const CONTENT_HASHED_NAME = /(?:^|\.)[0-9a-f]{16,}(?:\.|$)/;

function staticCacheControl(filePath) {
  const name = path.basename(filePath);
  if (
    path.extname(name).toLowerCase() !== ".html" &&
    CONTENT_HASHED_NAME.test(name)
  ) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

function notModifiedSince(ifModifiedSince, mtime) {
  if (typeof ifModifiedSince !== "string") {
    return false;
  }
  const since = Date.parse(ifModifiedSince);
  // HTTP dates have whole-second precision.
  return (
    Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since
  );
}

function serveStatic(
  req,
  res,
  prefix,
  transformedIndex,
  responseSecurityHeaders,
) {
  const urlPath = req.url.split("?", 1)[0];
  let stripped = urlPath;
  if (prefix !== "/" && urlPath.startsWith(prefix)) {
    stripped = urlPath.slice(prefix.length);
    if (!stripped.startsWith("/")) {
      stripped = `/${stripped}`;
    }
  }
  if (stripped === "/" || stripped === "" || stripped === "/index.html") {
    serveIndex(res, transformedIndex, responseSecurityHeaders);
    return;
  }

  const target = safeJoin(STATIC_ROOT, stripped);
  if (target == null) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  fs.stat(target, (statErr, stats) => {
    if (statErr || !stats) {
      // SPA fallback: serve index.html for paths without an extension
      // (client-side router).
      if (!path.extname(target)) {
        serveIndex(res, transformedIndex, responseSecurityHeaders);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    if (stats.isDirectory()) {
      const indexPath = path.join(target, "index.html");
      fs.readFile(indexPath, (readErr, body) => {
        if (readErr) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          ...responseSecurityHeaders,
        });
        res.end(body);
      });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    const lastModified = stats.mtime.toUTCString();
    const cacheHeaders = {
      "Cache-Control": staticCacheControl(target),
      "Last-Modified": lastModified,
    };
    if (notModifiedSince(req.headers["if-modified-since"], stats.mtime)) {
      res.writeHead(304, { ...cacheHeaders, ...responseSecurityHeaders });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stats.size,
      ...cacheHeaders,
      ...responseSecurityHeaders,
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ---- HTTP server wiring ----------------------------------------------------

function isWebSocketUpgrade(req) {
  return (
    req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket"
  );
}

function isWebSocketPath(reqUrl) {
  const pathname = reqUrl.split("?", 1)[0];
  return pathname === "/ws" || pathname.endsWith("/ws");
}

function endpointMatches(reqUrl, publicPrefix, endpoint) {
  const pathname = reqUrl.split("?", 1)[0];
  return (
    pathname === `/${endpoint}` ||
    (publicPrefix !== "/" && pathname === `${publicPrefix}/${endpoint}`)
  );
}

function writeJson(res, status, payload, responseSecurityHeaders) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...responseSecurityHeaders,
  });
  res.end(body);
}

function buildRequestListener(
  targetWs,
  publicPrefix,
  transformedIndex,
  buildInfo,
  responseSecurityHeaders,
  persistence,
  originAllowed = () => false,
  initialLayout,
  viewGateway,
) {
  return async function requestListener(req, res) {
    const requestUrl = new URL(req.url, "http://localhost");
    const base = publicPrefix === "/" ? "" : publicPrefix;
    if (requestUrl.pathname === `${base}/layout.json`) {
      writeJson(
        res,
        initialLayout && req.method === "GET" ? 200 : 404,
        initialLayout ?? {},
        responseSecurityHeaders,
      );
      return;
    }
    // A browser declares its origin on every write. A same-origin read does not
    // always send Origin, so a read may fall back to the page that issued it.
    const declaredOrigin = (sameOriginRead) =>
      req.headers.origin ??
      (sameOriginRead &&
      req.headers["sec-fetch-site"] === "same-origin" &&
      req.headers.referer
        ? new URL(req.headers.referer).origin
        : undefined);
    const viewState = requestUrl.pathname === `${base}/xgc2/view`;
    const viewEvents = requestUrl.pathname === `${base}/xgc2/view/events`;
    if (viewState || viewEvents) {
      // The desired view is stated through the control service; pages read it.
      try {
        if (!originAllowed(declaredOrigin(true)))
          throw new PersistenceError(
            "permission_denied",
            "view origin is not allowed",
            403,
          );
        if (!viewGateway)
          throw new PersistenceError(
            "unavailable",
            "the desired view is not configured",
            503,
          );
        if (req.method !== "GET")
          throw new PersistenceError("invalid_argument", "GET required", 400);
        if (viewState) viewGateway.state(res, responseSecurityHeaders);
        else viewGateway.events(req, res, responseSecurityHeaders);
      } catch (error) {
        if (!res.destroyed && !res.headersSent)
          writeJson(
            res,
            error.status ?? 503,
            {
              code: error.code ?? "unavailable",
              message:
                error instanceof PersistenceError
                  ? error.message
                  : "the desired view is unavailable",
            },
            responseSecurityHeaders,
          );
      }
      return;
    }
    const documentRoute = requestUrl.pathname === `${base}/xgc2/storage`;
    const assetRoute = requestUrl.pathname === `${base}/xgc2/extensions/assets`;
    const assetRead = requestUrl.pathname.startsWith(
      `${base}/xgc2/extensions/assets/`,
    );
    if (documentRoute || assetRoute || assetRead) {
      let input;
      try {
        // Require a declared browser Origin on every persistence route. The
        // desktop bridge calls the domain client inside the main process.
        if (!originAllowed(declaredOrigin(assetRead)))
          throw new PersistenceError(
            "permission_denied",
            "persistence origin is not allowed",
            403,
          );
        if (!persistence)
          throw new PersistenceError(
            "unavailable",
            "managed persistence is not configured",
            503,
          );
        if (documentRoute) {
          if (
            req.method !== "POST" ||
            req.headers["content-type"]?.split(";")[0] !== "application/json"
          )
            throw new PersistenceError(
              "invalid_argument",
              "JSON POST required",
              400,
            );
          input = JSON.parse(
            (await readBoundedBody(req, MAX_WIRE_BYTES)).toString("utf8"),
          );
          rejectViewFamily(input);
          writeJson(
            res,
            200,
            await persistence.request(input),
            responseSecurityHeaders,
          );
        } else if (assetRoute) {
          if (
            req.method !== "POST" ||
            req.headers["content-type"] !== "application/octet-stream"
          )
            throw new PersistenceError(
              "invalid_argument",
              "binary archive POST required",
              400,
            );
          const bytes = await readBoundedBody(req, MAX_ASSET_BYTES);
          const asset = await persistence.publish(bytes, {
            id: requestUrl.searchParams.get("name"),
            version: requestUrl.searchParams.get("version"),
          });
          writeJson(res, 200, asset, responseSecurityHeaders);
        } else {
          if (req.method !== "GET")
            throw new PersistenceError(
              "invalid_argument",
              "archive GET required",
              400,
            );
          const rawBytes = requestUrl.searchParams.get("bytes");
          if (!/^[1-9][0-9]{0,7}$/.test(rawBytes ?? ""))
            throw new PersistenceError(
              "invalid_argument",
              "canonical archive length required",
              400,
            );
          const bytes = await persistence.load({
            owner: "lichtblick",
            asset_id: decodeURIComponent(
              requestUrl.pathname.slice(
                `${base}/xgc2/extensions/assets/`.length,
              ),
            ),
            sha256: requestUrl.searchParams.get("sha256"),
            bytes: Number(rawBytes),
          });
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": bytes.byteLength,
            "Cache-Control": "no-store",
            ...responseSecurityHeaders,
          });
          res.end(bytes);
        }
      } catch (error) {
        if (!res.destroyed && !res.headersSent)
          writeJson(
            res,
            error.status ??
              (error instanceof SyntaxError || error instanceof URIError
                ? 400
                : 503),
            {
              code:
                error.code ??
                (error instanceof SyntaxError
                  ? "invalid_argument"
                  : "unavailable"),
              message:
                error instanceof PersistenceError ||
                error instanceof SyntaxError
                  ? error.message
                  : "managed persistence operation failed",
              ...(error.outcome ? { outcome: error.outcome } : {}),
              ...(error.requestId || input?.requestId
                ? { requestId: error.requestId ?? input.requestId }
                : {}),
            },
            responseSecurityHeaders,
          );
      }
      return;
    }
    if (isWebSocketPath(req.url)) {
      // Hand off to raw socket handling in `upgrade` handler below.
      res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("upgrade required");
      return;
    }
    // Lightweight health probe (no cache; useful for Process Supervisor and
    // container readiness checks).
    if (
      endpointMatches(req.url, publicPrefix, "healthz") ||
      endpointMatches(req.url, publicPrefix, "health")
    ) {
      writeJson(
        res,
        200,
        {
          status: "ok",
          upstream: `${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
        },
        responseSecurityHeaders,
      );
      return;
    }
    if (endpointMatches(req.url, publicPrefix, "version")) {
      writeJson(res, 200, buildInfo, responseSecurityHeaders);
      return;
    }
    serveStatic(
      req,
      res,
      publicPrefix,
      transformedIndex,
      responseSecurityHeaders,
    );
  };
}

// ---- Entry point -----------------------------------------------------------

async function readBoundedBody(request, limit) {
  const length = request.headers["content-length"];
  if (
    length !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > limit)
  )
    throw new PersistenceError(
      "resource_exhausted",
      "request body exceeds product limit",
      413,
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw new PersistenceError(
        "resource_exhausted",
        "request body exceeds product limit",
        413,
      );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function main() {
  loadEnvFile(ENV_FILE);

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX}: ${err.message}\n`);
    process.stderr.write(`Try '${LOG_PREFIX} --help' for usage.\n`);
    process.exit(2);
  }
  if (opts.showHelp) {
    printHelp();
    return;
  }

  const host = opts.host ?? process.env.HOST ?? DEFAULT_HOST;
  const port =
    opts.port ?? (Number.parseInt(process.env.PORT ?? "", 10) || DEFAULT_PORT);
  const controlPlaneUrl =
    opts.controlPlaneUrl ??
    process.env.CONTROL_PLANE_URL ??
    DEFAULT_CONTROL_PLANE_URL;
  const publicUrlPrefix =
    opts.publicUrlPrefix ??
    process.env.PUBLIC_URL_PREFIX ??
    DEFAULT_PUBLIC_URL_PREFIX;
  const configuredOriginValues = [
    process.env.ALLOWED_ORIGINS ?? "",
    ...opts.allowedOrigins,
  ];
  const frameAncestorsValue =
    opts.frameAncestors ??
    process.env.FRAME_ANCESTORS ??
    DEFAULT_FRAME_ANCESTORS;
  let targetWs;
  try {
    targetWs = parseWsUrl(controlPlaneUrl);
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX}: ${err.message}\n`);
    process.exit(2);
  }

  // Normalize prefix to always start with "/" and not end with "/" unless
  // it IS "/".
  let prefix = publicUrlPrefix;
  if (!prefix.startsWith("/")) {
    prefix = `/${prefix}`;
  }
  if (prefix.length > 1 && prefix.endsWith("/")) {
    prefix = prefix.slice(0, -1);
  }

  let loadIndex;
  let buildInfo;
  let validatedFrameAncestors;
  let configuredOrigins;
  let initialLayout;
  try {
    loadIndex = createIndexLoader(
      prefix,
      STATIC_ROOT,
      opts.assetUrlPrefix ?? process.env.ASSET_URL_PREFIX ?? null,
    );
    if (opts.layoutStdin) {
      initialLayout = readJSONInput();
      if (
        !initialLayout ||
        typeof initialLayout !== "object" ||
        Array.isArray(initialLayout) ||
        !initialLayout.configById ||
        !initialLayout.layout
      )
        throw new Error("prepared LayoutData required");
      const sourceIndex = loadIndex;
      const json = JSON.stringify(initialLayout).replace(
        /[<>&\u2028\u2029]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      loadIndex = () =>
        sourceIndex().replace(
          "/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/",
          json,
        );
    }
    loadIndex();
    buildInfo = loadBuildInfo();
    validatedFrameAncestors = validateFrameAncestors(frameAncestorsValue);
    configuredOrigins = parseConfiguredOrigins(configuredOriginValues);
  } catch (err) {
    process.stderr.write(
      `${LOG_PREFIX}: cannot prepare web entrypoint: ${err.message}\n`,
    );
    process.exit(1);
  }

  const responseSecurityHeaders = securityHeaders(validatedFrameAncestors);
  const shutdownMs = opts.shutdownMs ?? SHUTDOWN_MS;
  let persistence;
  let control;
  let views;
  let hostRuntime;
  let diagnostics;
  let allowedOrigins = configuredOrigins;
  let listenPort;
  let closing;
  const close = () => {
    if (!closing) {
      persistence?.beginDrain();
      closing = (async () => {
        control?.markNotReady("stopping");
        views?.close();
        const results = await Promise.allSettled([
          hostRuntime?.close(),
          control?.close(),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        await persistence?.close();
        await diagnostics?.close({ timeoutMs: shutdownMs });
      })().catch((error) => {
        closing = undefined;
        throw error;
      });
    }
    return closing;
  };
  const shutdown = (signal) => {
    logInfo(`received ${signal}, shutting down`);
    void close().then(
      () => process.exit(0),
      (error) => {
        logError(
          `shutdown incomplete; owner retains resources: ${error.message}`,
        );
        process.exitCode = 1;
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  try {
    if (!opts.startupInput)
      throw new Error("--startup-input is required");
    if (!opts.controlSocket)
      throw new Error("--control-socket is required");
    checkUnixAddress(opts.controlSocket, "--control-socket");
    const input = loadStartupInput(opts.startupInput);
    diagnostics = new Diagnostics({
      sink: { kind: "supervisor_stderr", rotationOwner: "supervisor" },
    });
    persistence = createManagedDomainClientFromInput(input, { diagnostics });
    const viewStore = new ViewStore(persistence);
    views = createViewGateway(viewStore);
    // The service listens first, so its owner can wait on describe while the
    // storage and the page listener come up; it is ready when the pages are.
    control = createControlService(persistence, {
      socketPath: opts.controlSocket,
      viewStore,
      diagnostics,
      shutdownMs,
      dependency: {
        // The view document is the smallest read that proves the bound storage instance answers.
        check: async () => {
          await persistence.request(
            { operation: "snapshot", keys: [{ family: "view", key: "desired" }] },
            { timeoutMs: 3000 },
          );
        },
        onChange: ({ ready, reason }) => {
          if (ready) logInfo("storage answers again");
          else logWarn(reason);
        },
      },
      facts: () => ({
        assets: input.assets.access,
        control_plane: `${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
        pages: { view_streams: views.streamCount },
        ...(listenPort ? { http_port: listenPort } : {}),
      }),
    });
    await control.start();
    await persistence.ready;
    await viewStore.load();
    hostRuntime = createHTTPHost(
      buildRequestListener(
        targetWs,
        prefix,
        loadIndex,
        buildInfo,
        responseSecurityHeaders,
        persistence,
        (origin) => websocketOriginAllowed(origin, allowedOrigins),
        initialLayout,
        views,
      ),
      {
        diagnostics,
        maxConnections: 64,
        maxInFlight: 64,
        maxBodyBytes: MAX_ASSET_BYTES,
        maxResponseBytes: 64 * 1024 * 1024,
        shutdownMs,
      },
    );
  } catch (error) {
    logError(`startup failed: ${error.message}`);
    await close().catch(() => {});
    process.exitCode = 1;
    return;
  }
  const server = hostRuntime.server;

  hostRuntime.onUpgrade((req, clientSocket, head) => {
    if (!isWebSocketUpgrade(req)) {
      clientSocket.destroy();
      return;
    }
    if (!isWebSocketPath(req.url)) {
      clientSocket.write(
        "HTTP/1.1 404 Not Found\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n",
      );
      clientSocket.destroy();
      return;
    }
    if (!websocketOriginAllowed(req.headers.origin, allowedOrigins)) {
      logWarn(
        `rejecting WebSocket origin: ${String(req.headers.origin ?? "<missing>")}`,
      );
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n",
      );
      clientSocket.destroy();
      return;
    }
    proxyWebSocket(
      req,
      clientSocket,
      head,
      `${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
    );
  });

  server.on("listening", () => {
    const addr = server.address();
    const bound =
      typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : "?";
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    allowedOrigins = new Set([
      ...defaultListenerOrigins(actualPort),
      ...configuredOrigins,
    ]);
    const displayPath = prefix === "/" ? "/" : `${prefix}/`;
    logInfo(`serving Lichtblick web bundle on http://${bound}${displayPath}`);
    logInfo(
      `WebSocket upstream: ${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
    );
    logInfo(`allowed WebSocket origins: ${[...allowedOrigins].join(", ")}`);
    logInfo("open the URL above in a browser, or embed behind a reverse proxy");
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    listenPort = server.address().port;
    control.markReady();
    server.on("error", (error) => {
      logError(`server error: ${error.message}`);
      void close().then(
        () => {
          process.exitCode = 1;
        },
        (drainError) => {
          logError(
            `shutdown incomplete; owner retains resources: ${drainError.message}`,
          );
          process.exitCode = 1;
        },
      );
    });
  } catch (error) {
    logError(`public listener startup failed: ${error.message}`);
    await close();
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    logError(`startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeAssetUrlPrefix,
  staticCacheControl,
  notModifiedSince,
  buildAutoConnectScript,
  buildRequestListener,
  createIndexLoader,
  defaultListenerOrigins,
  endpointMatches,
  loadBuildInfo,
  normalizeOrigin,
  parseWsUrl,
  parseArgs,
  parseConfiguredOrigins,
  safeJoin,
  securityHeaders,
  transformIndexHtml,
  validateFrameAncestors,
  websocketOriginAllowed,
};
