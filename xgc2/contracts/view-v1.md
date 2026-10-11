# Lichtblick desired view v1

The desired view is what XGC Core wants the viewer pages to show: which layout,
which robot to follow, perspective or orthographic projection, and which
surfaces of the embedded workspace are open. Core states it once through the
control service; the launcher stores it with the other managed documents and
every page reads it when it connects and hears every later change. Pages never
write it.

## The document

```json
{"layoutId":"camera-ar","followRobot":"uav1","perspective":true,
 "visibleSurfaces":["3d-tools","topics"]}
```

A view has exactly these four fields, each optional. `null` or absent means
that the page keeps its own choice for that field.

| Field | Value |
| --- | --- |
| `layoutId` | identity of a layout in the managed layouts, 1..256 characters without control characters |
| `followRobot` | robot identifier, `[A-Za-z_][A-Za-z0-9_]{0,126}`; the page follows the frame `xgc/robots/<robot>/base_link` that every robot publishes |
| `perspective` | `true` perspective, `false` orthographic |
| `visibleSurfaces` | distinct embed surfaces that are open, any of `3d-tools`, `obstacle-scene`, `panel-settings`, `alerts`, `topics`, `layouts`, `variables`, `panel-controls`; at most one of the four left-sidebar surfaces (`panel-settings`, `alerts`, `topics`, `layouts`); `[]` closes everything |

The launcher canonicalizes a view (fields complete, surfaces in the order above)
so equal views are equal documents. It stores the document in the managed
documents, family `view`, key `desired`, of the **view scope**. Its revision is the
storage version of that document, a decimal string, `"0"` before the first
statement. A document of another shape is ignored and replaced by the next
statement. The document outlives the launcher: a launcher that starts again
serves the same view with the same revision.

### The view scope

The view lives in a scope of its own (`storage.view_scope` of the
[startup input](startup-input.schema.json): the same namespace, a different user
or workspace, authorized by the same credential). The reason is the revision
fence of the pages: every save of a page is conditional on the revision of the
document scope as the page last saw it, so a write of anything else into that
scope would make the next save of every open page fail with a revision conflict.
Revisions are per scope in the storage service, so stating a view never moves the
revision the pages are fenced by, and a page save never disturbs a view write.

The document client enforces the split: a request for the document scope that
names the `view` family is refused with `403` (so a browser cannot read or write
the view through the document gateway, and `POST /v1/persistence` cannot either),
and a request for the view scope names only the `view` family. The web launcher
does not start without a view scope. The owner of the storage grants the
credential to both scopes.

## Stating the view (control service)

- `GET /v1/view` returns `{"revision":"7","view":{…}}` with all four fields.
- `PUT /v1/view` with `{"view":{…},"expectedRevision":"7"}` replaces the view.
  `expectedRevision` is optional and makes the write conditional: another
  revision answers `409` (`conflict`). A view equal to the stored one changes
  nothing and keeps its revision (`"unchanged":true`). The reply is
  `{"revision":"8","view":{…},"unchanged":false}`; the write is acknowledged only
  after the storage receipt, so a view the caller was told about survives a restart.
- Writes are serialized, and a write that loses a race with another document of
  the same scope is read again and retried, never replayed blindly.
- A browser cannot write the view: the document gateway refuses every request
  that names the `view` family (`403`); pages only read it, through the routes
  below.

## Reading the view (pages)

Both routes are same-origin GET routes of the launcher, under the public URL
prefix, and follow the Origin rules of the other gateways (a declared Origin
must be allowed; a same-origin read without one is judged by its Referer).

- `GET xgc2/view` returns the current `{revision, view}` with `Cache-Control: no-store`.
- `GET xgc2/view/events` is a server-sent event stream. It starts with the
  current state, then sends one `view` event per change; `id` is the revision.
  A reconnecting page that sends the last revision it saw in `Last-Event-ID`
  receives no repeat when it is current. A heartbeat comment keeps idle streams
  open; at most 16 streams are open, and a stream whose peer stops reading is
  dropped. The launcher ends the streams when it stops and pages reconnect to
  the next launcher.

```
id: 8
event: view
data: {"revision":"8","view":{"layoutId":"camera-ar","followRobot":"uav1","perspective":true,"visibleSurfaces":["3d-tools"]}}
```

## How an embedded page applies a view

Only the embedded workspace (`?xgc2Embed=1`) follows the stream, through its
embedded workspace bridge. It applies each revision once and then leaves the
operator in charge, so a manual camera change is never fought. A repeated
revision is ignored; a new revision applies all of its stated fields again.

1. `layoutId`: the layout is selected if it exists in the managed layouts. A
   layout that does not exist is reported in the log and the rest of the view
   applies to the layout that is shown.
2. `visibleSurfaces`: the surfaces whose state differs are toggled; a sidebar
   shows one item, so selecting the wanted item replaces the open one.
3. `followRobot` and `perspective`: sent to the one native 3D panel that can be
   navigated, as soon as it exists (which may be after a layout switch), and only
   once the layout is the desired one. With no such panel, or more than one, the
   fields stay pending. A field is done when the panel shows the desired value.

Core-driven automatic changes of the view (for example following the robot that
raised an alert) are a design note only: see
[../docs/automatic-view-control.md](../docs/automatic-view-control.md).
