# Lichtblick managed persistence v1

The launcher owns the same-origin `POST xgc2/storage` product gateway. It binds
one reviewed `lichtblick` user/workspace scope to an instance-bound XRPC storage
reference; a browser cannot supply a scope, database path, collection, SQL or
asset path. Desktop callers use the same domain operations through their
preload bridge. Browser storage is not consulted during ordinary startup.

Families: `layouts`, `profile`, `configuration`, `workspace`, `extensions`,
`desktop`. Keys are UTF-8 identifiers, at most 480 bytes; they are not paths.
Layout keys retain namespace and layout identity. A layout value retains the
existing baseline/working distinction and managed Core wiring import rules.

## Domain operations

All requests and responses are JSON; failures retain their status and a
`{code,message,outcome?,requestId?}` body. Versions are decimal strings.

- `{operation:"snapshot", keys?:[{family,key}], families?:[family],
  after?:string, limit?:number, at?:Token}` returns
  `{token,records:[{family,key,version,value?,missing?,deleted?}],nextAfter?}`.
  Exactly one of keys or a single family is provided. Missing explicit keys have
  version `"0"`; tombstones retain their version. A page cannot mix revisions.
- `{operation:"batch", expected:Token, requestId:string,
  changes:[{family,key,expectedVersion,value?,delete?}]}` returns
  `{token,requestId,durability,versions}` only after the storage receipt commits.
  Layout data and its active profile pointer belong in the same batch.
- `{operation:"receipt", requestId:string}` queries a durable receipt after an
  uncertain commit. No write is automatically replayed after disconnect.

Token is storage v1 `{database_id,schema,revision}`. Domain changes map to one
storage v1 batch. The document collection stores `{family,key,value}` with a
declared family index. Scope, schema and database fencing remain intact.

Limits: 64 requested keys, one family per page, 256 changes, 4 MiB wire request/response,
2 MiB per layout, 64 KiB per preference/profile/workspace/desktop document,
256 KiB per extension metadata record. Queues, pages and sessions are bounded.
Conflicts are shown to the caller; old persisted data remains intact. Pending
edits do not claim durability and page unload does not promise a network save.

Extension archives/code use a separately granted managed filesystem owner with
immutable `{owner,asset_id,sha256,bytes}` references. Publication precedes the
metadata CAS commit; failed publication/commit retains the previous installed
version. A ZIP and a database commit are not claimed to be one transaction.

## Write retirement and recovery

| Previous writer | Current owner / trigger | Recovery |
| --- | --- | --- |
| IndexedDB layouts, working copy and camera view | layouts; layout manager save / debounced working edit | working data restores camera; explicit baseline is retained |
| localStorage studio.layout second copy | removed; same layout owner | no second persisted copy |
| localStorage profile | profile; initial firstSeen and selected layout | same user/workspace snapshot |
| localStorage app configuration | configuration; explicit settings changes | load before UI/i18n initialization |
| Zustand workspace localStorage | workspace; sidebar/playback/tour preferences | hydrate before store initialization; dialogs remain memory |
| i18next hidden language cache | configuration LANGUAGE | detector caching disabled |
| panel log height localStorage | workspace panel-log-height | loaded with UI preferences |
| launch preference sessionStorage | memory for temporary launch intention | persistent choice uses configuration |
| IndexedDB extension metadata/archive | extensions metadata + granted immutable assets | installed metadata selects verified archive |
| Electron userData datastore/settings | desktop/configuration via preload domain bridge | no mkdir/read side effect or arbitrary filesystem access |
| HOME .lichtblick-suite extension unpack | same managed extension owner | archive is published before installed pointer switches |
| IndexedDB recent connections/files | workspace.recents metadata; player recents updates | native FileSystemFileHandle stays in memory; reopening a local file requires a fresh user selection |
| react-use blick.logs-settings localStorage | workspace.log-settings; explicit logger preferences | bootstrap from the same managed document |

The runtime manifest declares owner, scope, limits and recovery for every family.
Database files/backup locations belong to xgc2-storage. Assets are granted under
the existing user-document XGC application tree; the product never resolves
HOME/cwd or silently creates a new root. The runtime accepts the current schema;
it has no automatic old-browser/datastore import, fallback or dual read/write
path. Existing bytes are untouched by isolated development; compatibility with
the former database is not a requirement for the new product.

## Native startup and ownership

Web launcher and desktop main require `--bootstrap-input <absolute-private-file>`.
The shared SDK reads and validates the common BootstrapInput envelope and private
TLS/bearer grants. This product validates only its `application` payload against
`bootstrap-application.schema.json`: current schema, exact scope, live local
storage reference, two distinct declared document/asset grants, explicit asset
access, and the operator Settings time zone. There is no certificate, token,
transport, scope or asset-root discovery from HOME, cwd or product environment.
The native HTTPS Lichtblick host advertises its actual `xgc2.lichtblick.v1.Lichtblick`
ServiceRef after application startup; the application owns readiness and closes
both public and private admission before releasing storage and asset resources.
Core does not start a sidecar or probe.

The composition root resolves the common runtime policy once from a startup
environment snapshot and injects it into clients and hosts. Their concurrency
resources remain distinct. One common SDK Diagnostics owner serves all role views;
its bounded stderr worker closes after actual host and domain work drains. The
supervisor owns log rotation. Desktop consumes the installed Node SDK at
`/usr/lib/xgc2/node_modules/@xgc2/xrpc` as a whole external module, preserving
the SDK's native worker and private dependency paths. Calls are limited to 15 seconds and ordinary drain to
16 seconds. An incomplete drain retains its resources and refuses to claim
exit; the owner can request drain again after actual work has quiesced.
Public bundle responses require up to 64 MiB; document
requests/responses are limited to 4 MiB and extension archives to 8 MiB. A role's
budget must be enforced by the common SDK; route validation does not substitute
for transport byte limits.

A read-write asset grant owns one exclusive Linux file lease for its complete
lifecycle. The bounded `/usr/bin/flock` startup helper exits immediately; the
parent holds the inherited open-file-description until actual work drains.
Linux `util-linux` is an installation dependency. A second writer fails startup;
there is no retry, alternate directory or quota reset. A read-only grant loads
verified immutable references without taking the writer lease and rejects
publication. Web and desktop sharing a writable root must send operations to
its existing single asset owner. Directory descriptors anchor IO; path replacement
cannot redirect the grant. The fixed private lease file is control state, not a
user archive. Publication names use the operator time zone, whole wall-clock
seconds and a bounded short sequence; recorded instants use UTC.
