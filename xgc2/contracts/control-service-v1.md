# Lichtblick control service v1

`xgc2.lichtblick.v1` (`api_version` `"1"`) is the domain service of the web
launcher. It is an XRPC `http.v1` host on a Unix socket. The process owner (XGC
Core) discovers it like every other service, waits for its readiness with one
`describe` call, and then states what the viewer pages show and reaches the
managed documents and extension assets of the launcher.

The desktop application hosts no service: it takes the same startup input and
prints one `{"type":"ready"}` line once its first window has loaded.

## Hosting

- `--control-socket <absolute path>` names the socket. The path is canonical and
  shorter than 108 bytes and lies inside a private runtime directory (mode
  `0700`, owned by the same user) that the owner allocates. The launcher creates
  the socket with mode `0600`.
- A socket left behind by a process that no longer exists is reclaimed. A socket
  with a live listener is never taken; the launcher fails to start.
- Nothing but that directory authorizes a caller. There is no TLS, no bearer
  token and no certificate: the former HTTPS wrapper and its per-launch
  credentials do not exist.
- The launcher listens before its storage and its page listener are up, so the
  owner can wait on `describe` while it starts. It removes the socket when it
  stops.
- The private startup input (`--startup-input`, see
  [startup-input.schema.json](startup-input.schema.json)) names the document
  storage reference, its scope, the scope of the desired view and the credential
  file, and the extension asset grant. It is the only way storage is configured.
  The credential must authorize both scopes.

## Instance fence and headers

Every request carries `X-Request-ID` and `X-Xrpc-Timeout-Ms`. `instance_id` is
fresh on every process start. Discovery matches the `GET /v1/describe` path
only, including a `wait_ready_ms` query, and requires no `X-Xrpc-Instance-ID`.
Every other call carries the instance in that header and is refused with `409`
when it is missing or differs. A discovery call that supplies the header is
also fenced, so a caller bound to a previous process can never reach the next
one. Calls are limited to 15 seconds.

## Readiness

`GET /v1/describe` returns

```json
{"service":"xgc2.lichtblick.v1","api_version":"1","instance_id":"<32 hex>","ready":true,
 "facts":{"capabilities":["persistence.v1","extensions.assets.v1","view.v1"],
          "view_revision":"7","storage":"ready","assets":"read-write",
          "control_plane":"ws://127.0.0.1:8765/","pages":{"view_streams":1},"http_port":18081}}
```

`ready` is true while the launcher serves its pages and the storage it is bound
to answers. Otherwise `facts.reason` says why:

| `reason` | Meaning |
| --- | --- |
| `starting` | storage or page listener not up yet |
| `stopping` | drain after SIGTERM or SIGINT |
| `storage unavailable (<code>)` | the storage stopped answering, or it is another instance than the one in the startup input |

The launcher asks its storage for the smallest read every five seconds. A
storage that was replaced is a different environment for this binding: the
service never rebinds, stays `ready:false` with the reason and the owner
restarts it. A storage that answers again makes the service ready again.

`GET /v1/describe?wait_ready_ms=<0..30000>` is an unbound discovery call. Core
can issue it before it knows the instance. It holds the request, without
polling, until `ready` is true, the wait elapses or the call's own deadline is
near, and then answers with the current document. At most 16 calls are held;
stopping answers them at once.

## Operations

All other operations answer `503` (`unavailable`) until the launcher is ready.

| Operation | Request | Reply |
| --- | --- | --- |
| `POST /v1/persistence` | JSON domain body of the [persistence contract](persistence-v1.md) (`snapshot`, `batch`, `receipt`) | the domain reply; the `requestId` of a `batch` equals the transport `X-Request-ID`, otherwise the call fails with `409` |
| `POST /v1/extensions/assets?name=<id>&version=<v>` | `application/octet-stream` archive, at most 8 MiB | the immutable `{owner,asset_id,sha256,bytes}` reference |
| `POST /v1/extensions/load` | JSON reference, at most 2 KiB | `application/octet-stream` archive |
| `GET /v1/view` | none | `{revision, view}` |
| `PUT /v1/view` | `{view, expectedRevision?}` | `{revision, view, unchanged}` |

The persistence operations act on the document scope and refuse the `view`
family; the view operations act on the view scope and are specified in
[view-v1.md](view-v1.md).

## Errors

A failure keeps its HTTP status and has the body
`{"code":"…","message":"…","outcome":"…"?,"requestId":"…"?}`. Codes:
`invalid_argument` (400), `permission_denied` (403), `not_found` (404),
`conflict` (409), `resource_exhausted` (413, 503), `unavailable` (503),
`internal` (502). `outcome` is `outcome_unknown` when a write may have been
applied; no write is replayed automatically.

## Limits and shutdown

32 connections and 32 calls in flight, 8 MiB request and response bodies,
4 MiB for persistence documents. SIGTERM and SIGINT stop admission, answer held
`describe` calls with `reason:"stopping"`, end the view streams and drain
admitted work within 16 seconds (`--shutdown-ms`, at most 60000). An incomplete
drain keeps the asset lease and the process alive rather than claiming to have
stopped.

The listener of the pages, the same-origin gateways (`POST /xgc2/storage`,
`/xgc2/extensions/assets`, `GET /xgc2/view`, `GET /xgc2/view/events`) and the
WebSocket proxy are described by the [persistence](persistence-v1.md) and
[view](view-v1.md) contracts and the [README](../README.md).
