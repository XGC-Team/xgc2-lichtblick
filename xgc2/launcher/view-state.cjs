// SPDX-License-Identifier: MPL-2.0
"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { PersistenceError } = require("./managed-storage.cjs");

// The desired view of the viewer pages: the one document Core states and every
// page reads. It lives in the launcher's managed document storage, family
// `view`, so it outlives the launcher and a page that opens later finds it.
const VIEW_FAMILY = "view";
const VIEW_KEY = "desired";
// The surfaces the embed protocol can show; the order is the canonical one. The left
// sidebar shows one item at a time, so a view names at most one of its surfaces.
const SURFACES = Object.freeze(["3d-tools", "obstacle-scene", "panel-settings", "alerts", "topics", "layouts", "variables", "panel-controls"]);
const LEFT_SIDEBAR = Object.freeze(["panel-settings", "alerts", "topics", "layouts"]);
const FIELDS = Object.freeze(["layoutId", "followRobot", "perspective", "visibleSurfaces"]);
const ROBOT = /^[A-Za-z_][A-Za-z0-9_]{0,126}$/;
const LAYOUT_ID = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const EMPTY_VIEW = Object.freeze({ layoutId: null, followRobot: null, perspective: null, visibleSurfaces: null });
const ATTEMPTS = 3;

function invalid(message) { throw new PersistenceError("invalid_argument", message, 400); }

/**
 * A view is exactly four fields; null means that the page keeps its own choice
 * for that field. The result is canonical, so equal views are equal values.
 */
function normalizeView(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) invalid("view must be an object");
  for (const key of Object.keys(value)) if (!FIELDS.includes(key)) invalid(`unknown view field ${key}`);
  const { layoutId = null, followRobot = null, perspective = null, visibleSurfaces = null } = value;
  if (layoutId !== null && (typeof layoutId !== "string" || !LAYOUT_ID.test(layoutId))) invalid("layoutId must be a layout identity or null");
  if (followRobot !== null && (typeof followRobot !== "string" || !ROBOT.test(followRobot))) invalid("followRobot must be a robot identifier or null");
  if (perspective !== null && typeof perspective !== "boolean") invalid("perspective must be a boolean or null");
  let surfaces = null;
  if (visibleSurfaces !== null) {
    if (!Array.isArray(visibleSurfaces) || visibleSurfaces.some((surface) => !SURFACES.includes(surface)) || new Set(visibleSurfaces).size !== visibleSurfaces.length) {
      invalid("visibleSurfaces must list distinct embed surfaces or be null");
    }
    if (visibleSurfaces.filter((surface) => LEFT_SIDEBAR.includes(surface)).length > 1) invalid("visibleSurfaces can show only one left sidebar surface");
    surfaces = SURFACES.filter((surface) => visibleSurfaces.includes(surface));
  }
  return { layoutId, followRobot, perspective, visibleSurfaces: surfaces };
}

/** A browser may read the view, never write it: refuse any document request that names its family. */
function rejectViewFamily(request) {
  const names = [];
  if (request && typeof request === "object") {
    for (const key of request.keys ?? []) names.push(key?.family);
    for (const family of request.families ?? []) names.push(family);
    for (const change of request.changes ?? []) names.push(change?.family);
  }
  if (names.includes(VIEW_FAMILY)) throw new PersistenceError("permission_denied", "the desired view is controlled through the control service", 403);
}

class ViewStore {
  #client;
  #state = { revision: "0", view: EMPTY_VIEW };
  #listeners = new Set();
  #queue = Promise.resolve();

  constructor(client) { this.#client = client; }

  /** The applied desired view and its revision: the storage version of its document, "0" before any write. */
  get state() { return this.#state; }

  async load() {
    const { revision, view } = await this.#read();
    this.#state = { revision, view };
    return this.#state;
  }

  /** Calls `listener(state)` after every change made through this store; returns the function that stops it. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /**
   * Replaces the desired view. `expectedRevision` makes the write conditional;
   * a view equal to the stored one is a no-op that keeps its revision. Writes are
   * serialized, and a write that lost a race with an unrelated document is read
   * again, never replayed blindly.
   */
  async set(input, { expectedRevision } = {}) {
    const view = normalizeView(input);
    if (expectedRevision !== undefined && (typeof expectedRevision !== "string" || !DECIMAL.test(expectedRevision))) invalid("expectedRevision must be a decimal string");
    const work = this.#queue.then(() => this.#write(view, expectedRevision));
    this.#queue = work.catch(() => {});
    return await work;
  }

  async #read() {
    const snapshot = await this.#client.request({ operation: "snapshot", keys: [{ family: VIEW_FAMILY, key: VIEW_KEY }] });
    return { token: snapshot.token, ...this.#interpret(snapshot.records[0]) };
  }

  #interpret(record) {
    if (!record || record.missing || record.deleted) return { revision: record?.version ?? "0", view: EMPTY_VIEW, stored: false };
    try {
      return { revision: record.version, view: Object.freeze(normalizeView(record.value)), stored: true };
    } catch {
      // A document of another schema must not stop the viewer; the next write replaces it.
      return { revision: record.version, view: EMPTY_VIEW, stored: false };
    }
  }

  async #write(view, expectedRevision) {
    for (let attempt = 1; ; attempt++) {
      const current = await this.#read();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        this.#state = { revision: current.revision, view: current.view };
        throw new PersistenceError("conflict", "view revision conflict", 409);
      }
      if (current.stored && isDeepStrictEqual(current.view, view)) {
        this.#state = { revision: current.revision, view: current.view };
        return { ...this.#state, unchanged: true };
      }
      try {
        const receipt = await this.#client.request({
          operation: "batch", expected: current.token, requestId: `view-${randomUUID()}`,
          changes: [{ family: VIEW_FAMILY, key: VIEW_KEY, expectedVersion: current.revision, value: view }],
        });
        this.#state = { revision: receipt.versions[0].version, view: Object.freeze(view) };
        for (const listener of this.#listeners) listener(this.#state);
        return { ...this.#state, unchanged: false };
      } catch (error) {
        // Another document of the scope changed the database revision between the read and the write.
        if (error.code === "conflict" && attempt < ATTEMPTS) continue;
        // An uncertain write is settled by reading it back.
        if (error.outcome === "outcome_unknown") await this.load().catch(() => {});
        throw error;
      }
    }
  }
}

module.exports = { VIEW_FAMILY, VIEW_KEY, SURFACES, EMPTY_VIEW, ViewStore, normalizeView, rejectViewFamily };
