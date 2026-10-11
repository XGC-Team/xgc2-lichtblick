# Automatic view control (design note)

Status: design only. Nothing in this note is implemented. This change delivers the
mechanism Core would use: a desired view that Core states and the launcher stores,
serves and streams ([view-v1.md](../contracts/view-v1.md),
[control-service-v1.md](../contracts/control-service-v1.md)).

## Problem

An operator watches a Run through the embedded viewer. Some events should change
what the viewer shows without a click: a robot raises an alert and the viewer
follows it; the experiment enters the camera calibration phase and the viewer
shows the image layout; a robot is selected on the Core page and the viewer
follows it. Today Core can state a view, but nothing decides when.

## Principles

1. **Core owns the policy.** Only Core knows robots, phases, alerts and the
   operator's selection. The launcher stays a store and relay and learns nothing
   about robots or phases. No viewer page decides what the view is.
2. **One writer.** Within a Run, one Core component (the view controller, below)
   writes the view; manual statements through the same service from an
   administrative tool are the only other writers. Pages never write.
3. **The operator stays in charge.** Each page applies a revision once and then
   leaves the camera alone. The controller must not reassert a view the operator
   just changed.
4. **Writes are cheap, honest and rare.** An unchanged statement is a no-op that
   keeps its revision; every real change is durable before it is acknowledged;
   the controller coalesces bursts.

## Proposed shape

### The view controller (in Core, per Run)

A small component of the session package that:

- subscribes to signals Core already has: robot telemetry and alert events (the
  per-robot status projection), session and workflow phase events, and the
  operator's selection reported by the Core page;
- evaluates a short ordered list of rules (below) into **one desired view**;
- writes it with `PUT /v1/view` and `expectedRevision` set to the revision it
  last wrote or read, so it never overwrites a statement it has not seen;
- holds no state that cannot be recomputed: after a restart it reads
  `GET /v1/view`, recomputes, and writes only if the result differs.

It discovers the launcher like any other service (`describe`, then bound calls)
and treats `ready:false` as "no writes now"; a view it could not write is
recomputed when the service is ready again.

### Rules

A rule is `{when, view, priority, hold}`: when a signal matches, it contributes
`view` fields (any subset of the four fields) at `priority`, kept for at least
`hold` after the signal ends so the view does not flicker. For each field the
highest-priority contribution wins; fields no rule states stay `null`, which
leaves the page alone. Examples:

| When | Contribution | Priority |
| --- | --- | --- |
| robot `uavN` has a critical alert | `followRobot: uavN`, `perspective: true` | alert |
| session phase `camera-calibration` | `layoutId: <calibration layout>` | phase |
| operator selected robot `ugvM` on the Core page | `followRobot: ugvM` | selection |

Rules belong to Core configuration (saved per experiment next to the robot
visualization profiles), not to the launcher. The first implementation can ship
the three signals above and fixed priorities; rule editing is a later step.

### Operator override

Pages report the navigation state they already send to the Core page
(`navigation-state`: perspective, followed frame). When the operator changes the
camera by hand, the Core page tells Core, which suspends the controller's camera
fields (`followRobot`, `perspective`) for a configurable hold (default 30 s) or
until the operator presses "auto" again. Layout and surface fields are not
suspended by camera changes. While suspended the controller still tracks signals,
so releasing the hold applies the current desired view once, not the history.

### Run boundaries

The stored view outlives the launcher and the Run. At Run start Core states a full
view (every field set from the experiment's default, or `[]` for surfaces) so the
previous Run's choices do not leak into the next; `null` fields leave a page
unchanged and are therefore not a reset.

## Why not elsewhere

- **In the viewer pages:** they would need robot and phase knowledge and a second
  channel to Core, and two pages could disagree. Rejected.
- **In the launcher:** it would turn a store into a rules engine fed by Core
  events through a new interface. Rejected: Core already has the events.
- **As workflow nodes only:** an explicit `lichtblick.set-view` action (a
  capability call of the service) is still useful for authored workflows and for
  tests, and the controller can be written on top of the same call. It is not
  enough alone, because alerts and selection arrive outside workflows.

## Failure behaviour

- The launcher is down or `ready:false`: nothing is written; the view is
  recomputed when it is ready again. The Run is never affected.
- A write conflicts (`409`): the controller reads the current state, merges (its
  rules decide only the fields they contribute) and retries once.
- Many robots alert at once: one contribution per field wins by priority; ties
  break by the most recent signal; writes are limited to one per second.
- Several viewer pages are open: all follow the same view. A view per page would
  need a page identity in the contract and is out of scope.

## Open points

- Whether `followRobot` should accept `null` to mean "stop following" distinct
  from "leave alone". The contract today has no such value; the controller can
  use `layoutId` or an explicit overview command from the Core page instead.
- Which signals count as "critical alert" belongs to the robot status
  projection, not to this design.
- Measuring end-to-end latency from signal to camera move (event, write with
  durable receipt, stream, page apply). Expected in the low hundreds of
  milliseconds; the durable write dominates.

## Verification plan

A fake Core writer test (launcher level) for rule evaluation against recorded
signals; the existing browser harness for the page side (a stated view moves the
camera, a manual change is not reverted until the next revision); one session
level test with a real launcher and storage that follows an alert and honours an
override.
