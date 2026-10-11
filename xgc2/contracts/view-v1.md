# Lichtblick desired view v1

The desired view is what XGC Core wants the viewer pages to show: which layout,
which robot to follow, perspective or orthographic projection, and which
surfaces of the embedded workspace are open. Core states it once through the
control service; the launcher keeps it in memory. Every page reads it when it
connects and hears every later change. Pages never write it.

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
so equal views are equal documents. The document and its decimal-string revision
live in launcher memory. Revision is `"0"` before the first statement; the first
statement, including an empty view, has revision `"1"`. Each changed statement
increments it by one; an equal statement changes nothing. A restarted launcher
starts at revision `"0"` with no view (all four fields null). Core must restate
any desired view after restart. There is no view scope or Storage binding.

## Stating the view (control service)

- `GET /v1/view` returns `{"revision":"7","view":{…}}` with all four fields.
- `PUT /v1/view` with `{"view":{…},"expectedRevision":"7"}` replaces the view.
  `expectedRevision` is optional and makes the write conditional: another
  revision answers `409` (`conflict`). A view equal to the current one changes
  nothing and keeps its revision (`"unchanged":true`). The reply is
  `{"revision":"8","view":{…},"unchanged":false}` after the in-memory change.
- Writes are serialized. A stale `expectedRevision` is refused even when the
  proposed view equals the current one; a conflict changes no state.
- Pages only read the view through the routes below. They cannot write it through
  the page listener.

## Reading the view (pages)

Both routes are same-origin GET routes of the launcher, under the public URL
prefix, and follow the Origin rules of the page gateway (a declared Origin
must be allowed; a same-origin read without one is judged by its Referer).

- `GET xgc2/view` returns the current `{revision, view}` with `Cache-Control: no-store`.
- `GET xgc2/view/events` is a server-sent event stream. It starts with the
  current state, then sends one `view` event per change; `id` is the revision.
  A reconnecting page that sends the last revision it saw in `Last-Event-ID`
  receives no repeat when it is current. A heartbeat comment keeps idle streams
  open; at most 16 streams are open, and a stream whose peer stops reading is
  dropped. The launcher ends the streams when it stops and pages reconnect to
  the next launcher, whose state starts at revision `"0"`.

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
