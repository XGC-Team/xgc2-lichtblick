# Lichtblick control service v1

`xgc2.lichtblick.v1` (`api_version` `"1"`) is the domain service of the web
launcher. It is an XRPC `http.v1` host on a Unix socket. XGC Core discovers it,
waits for readiness and states the desired view of the viewer pages. The
launcher builds the initial layout from one high-level view input on stdin;
see [the README](../README.md). Core alone owns Storage and serves UI documents
to the browser under the user's session.

The desktop application hosts no service. Its startup input and managed
persistence contract are desktop only; it prints one `{"type":"ready"}` line
once its first window has loaded.

## Hosting

- `--control-socket <absolute path>` names the socket. The path is canonical,
  shorter than 108 bytes and inside a private runtime directory (mode `0700`,
  owned by the same user) allocated by the owner. The socket has mode `0600`.
- A socket left by a dead process is reclaimed. A live listener is never taken;
  the launcher fails to start.
- The directory authorizes callers. There is no TLS, bearer token or certificate.
- The control listener starts before the page listener, so the owner can hold an
  unbound `describe` readiness call during startup. Shutdown removes the socket.

## Instance fence and headers

Every request carries `X-Request-ID` and `X-Xrpc-Timeout-Ms`. `instance_id` is
fresh on every process start. Discovery matches the `GET /v1/describe` path
only, including a `wait_ready_ms` query, and requires no `X-Xrpc-Instance-ID`.
Every other call carries the instance in that header and is refused with `409`
when it is missing or differs. Discovery with an explicit instance header is
also fenced. Calls are limited to 15 seconds.

## Readiness

`GET /v1/describe` returns:

```json
{"service":"xgc2.lichtblick.v1","api_version":"1","instance_id":"<32 hex>","ready":true,
 "facts":{"capabilities":["view.v1"],"view_revision":"7",
          "control_plane":"ws://127.0.0.1:8765/","pages":{"view_streams":1},"http_port":18081}}
```

`ready` is true while the launcher serves its pages. Otherwise `facts.reason`
is `starting` (page listener not up yet) or `stopping` (shutdown).
Readiness has no Storage or asset dependency.

`GET /v1/describe?wait_ready_ms=<0..30000>` is an unbound discovery call. Core
can issue it before it knows the instance. It holds the request, without
polling, until ready, the wait elapses or the caller's deadline is near, then
answers with the current document. At most 16 calls are held; stopping answers
them at once. Other query members, noncanonical values and waits above 30000 ms
are refused with `400`.

## Operations

Health and view operations answer `503` (`unavailable`) until ready.

| Operation | Request | Reply |
| --- | --- | --- |
| `GET /v1/health` | none | `{"status":"ok"}` |
| `GET /v1/view` | none | `{revision, view}` |
| `PUT /v1/view` | `{view, expectedRevision?}` | `{revision, view, unchanged}` |

The view contract is [view-v1.md](view-v1.md). Its state is process-local and
starts at revision `"0"` on every restart. Persistence and extension-asset
operations are absent and undeclared routes answer `404`.

## Errors

A domain failure keeps its HTTP status and returns `{"code":"…","message":"…"}`.
Codes are `invalid_argument` (400), `not_found` (404), `conflict` (409),
`resource_exhausted` (413, 503) and `unavailable` (503). The XRPC host enforces
transport headers and the instance fence before domain dispatch.

## Limits and shutdown

32 connections and 32 calls in flight; 8 MiB host request and response budgets.
A view update body is limited to 8 KiB. SIGTERM and SIGINT stop admission,
answer held describe calls with `reason:"stopping"`, end the view streams and
drain admitted host work within 16 seconds (`--shutdown-ms`, at most 60000).
Diagnostics close after host work has drained.

The page listener also serves `/healthz`, `/version`, `layout.json`,
`GET xgc2/view`, `GET xgc2/view/events` and the WebSocket proxy under the public
URL prefix. Origin, CSP and WebSocket controls are unchanged; see
[view-v1.md](view-v1.md), the [README](../README.md) and
[reverse proxy examples](../launcher/reverse-proxy-examples.md).
