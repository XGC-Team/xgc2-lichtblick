// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

const { isDeepStrictEqual } = require("node:util");
// The desired view belongs to this launcher process. A new process starts with
// no statement and revision "0"; pages read the current state on reconnect.
class ViewError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "ViewError";
    this.code = code;
    this.status = status;
  }
}
// The surfaces the embed protocol can show; the order is the canonical one. The left
// sidebar shows one item at a time, so a view names at most one of its surfaces.
const SURFACES = Object.freeze([
  "3d-tools",
  "obstacle-scene",
  "panel-settings",
  "alerts",
  "topics",
  "layouts",
  "variables",
  "panel-controls",
]);
const LEFT_SIDEBAR = Object.freeze(["panel-settings", "alerts", "topics", "layouts"]);
const FIELDS = Object.freeze(["layoutId", "followRobot", "perspective", "visibleSurfaces"]);
const ROBOT = /^[A-Za-z_][A-Za-z0-9_]{0,126}$/;
const LAYOUT_ID = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const EMPTY_VIEW = Object.freeze({
  layoutId: null,
  followRobot: null,
  perspective: null,
  visibleSurfaces: null,
});

function invalid(message) {
  throw new ViewError("invalid_argument", message, 400);
}

/**
 * A view is exactly four fields; null means that the page keeps its own choice
 * for that field. The result is canonical, so equal views are equal values.
 */
function normalizeView(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    {invalid("view must be an object");}
  for (const key of Object.keys(value))
    {if (!FIELDS.includes(key)) {invalid(`unknown view field ${key}`);}}
  const { layoutId = null, followRobot = null, perspective = null, visibleSurfaces = null } = value;
  if (layoutId !== null && (typeof layoutId !== "string" || !LAYOUT_ID.test(layoutId)))
    {invalid("layoutId must be a layout identity or null");}
  if (followRobot !== null && (typeof followRobot !== "string" || !ROBOT.test(followRobot)))
    {invalid("followRobot must be a robot identifier or null");}
  if (perspective !== null && typeof perspective !== "boolean")
    {invalid("perspective must be a boolean or null");}
  let surfaces = null;
  if (visibleSurfaces !== null) {
    if (
      !Array.isArray(visibleSurfaces) ||
      visibleSurfaces.some((surface) => !SURFACES.includes(surface)) ||
      new Set(visibleSurfaces).size !== visibleSurfaces.length
    ) {
      invalid("visibleSurfaces must list distinct embed surfaces or be null");
    }
    if (visibleSurfaces.filter((surface) => LEFT_SIDEBAR.includes(surface)).length > 1)
      {invalid("visibleSurfaces can show only one left sidebar surface");}
    surfaces = SURFACES.filter((surface) => visibleSurfaces.includes(surface));
  }
  return { layoutId, followRobot, perspective, visibleSurfaces: surfaces };
}

class ViewStore {
  #state = Object.freeze({ revision: "0", view: EMPTY_VIEW });
  #stated = false;
  #listeners = new Set();
  #queue = Promise.resolve();

  /** Decimal-string revision of this process's desired view, "0" before its first statement. */
  get state() {
    return this.#state;
  }

  /** Calls `listener(state)` after every change; returns the function that stops it. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Serialized, optionally conditional replacement; an equal statement is a no-op. */
  async set(input, { expectedRevision } = {}) {
    const view = normalizeView(input);
    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== "string" || !DECIMAL.test(expectedRevision))
    )
      {invalid("expectedRevision must be a decimal string");}
    const work = this.#queue.then(() => {
      if (expectedRevision !== undefined && expectedRevision !== this.#state.revision)
        {throw new ViewError("conflict", "view revision conflict", 409);}
      if (this.#stated && isDeepStrictEqual(this.#state.view, view))
        {return { ...this.#state, unchanged: true };}
      if (view.visibleSurfaces) {Object.freeze(view.visibleSurfaces);}
      this.#state = Object.freeze({
        revision: String(BigInt(this.#state.revision) + 1n),
        view: Object.freeze(view),
      });
      this.#stated = true;
      for (const listener of this.#listeners) {listener(this.#state);}
      return { ...this.#state, unchanged: false };
    });
    this.#queue = work.catch(() => {});
    return await work;
  }
}

module.exports = { ViewError, SURFACES, EMPTY_VIEW, ViewStore, normalizeView };
