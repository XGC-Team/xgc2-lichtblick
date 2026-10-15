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
const FIELDS = Object.freeze([
  "layoutId",
  "followRobot",
  "perspective",
  "visibleSurfaces",
  "viewpoint",
]);
const ROBOT = /^[A-Za-z_][A-Za-z0-9_]{0,126}$/;
function validLayoutId(value) {
  const characters = Array.from(value);
  return (
    characters.length >= 1 &&
    characters.length <= 256 &&
    characters.every((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
  );
}
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
 * Null fields preserve the page choice. An optional viewpoint is an explicit
 * navigation command; the remaining fields keep their canonical values.
 */
function normalizeView(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalid("view must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!FIELDS.includes(key)) {
      invalid(`unknown view field ${key}`);
    }
  }
  const { layoutId = null, followRobot = null, perspective = null, visibleSurfaces = null } = value;
  if (!Object.is(layoutId, null) && (typeof layoutId !== "string" || !validLayoutId(layoutId))) {
    invalid("layoutId must be a layout identity or null");
  }
  if (
    !Object.is(followRobot, null) &&
    (typeof followRobot !== "string" || !ROBOT.test(followRobot))
  ) {
    invalid("followRobot must be a robot identifier or null");
  }
  if (!Object.is(perspective, null) && typeof perspective !== "boolean") {
    invalid("perspective must be a boolean or null");
  }
  let surfaces = null;
  if (!Object.is(visibleSurfaces, null)) {
    if (
      !Array.isArray(visibleSurfaces) ||
      visibleSurfaces.some((surface) => !SURFACES.includes(surface)) ||
      new Set(visibleSurfaces).size !== visibleSurfaces.length
    ) {
      invalid("visibleSurfaces must list distinct embed surfaces or be null");
    }
    if (visibleSurfaces.filter((surface) => LEFT_SIDEBAR.includes(surface)).length > 1) {
      invalid("visibleSurfaces can show only one left sidebar surface");
    }
    surfaces = SURFACES.filter((surface) => visibleSurfaces.includes(surface));
  }
  const result = {
    layoutId,
    followRobot,
    perspective,
    visibleSurfaces: surfaces,
  };
  if (Object.hasOwn(value, "viewpoint")) {
    const choice = value.viewpoint;
    if (
      choice == null ||
      typeof choice !== "object" ||
      Array.isArray(choice) ||
      Object.keys(choice).some((key) => key !== "id" && key !== "transition") ||
      typeof choice.id !== "string" ||
      choice.id.length === 0 ||
      choice.id.length > 256 ||
      !["smooth", "instant"].includes(choice.transition)
    ) {
      invalid("viewpoint requires {id, transition: smooth|instant}");
    }
    if (!Object.is(followRobot, null)) {
      invalid("viewpoint and followRobot cannot be combined");
    }
    result.viewpoint = { id: choice.id, transition: choice.transition };
  }
  return result;
}

class ViewStore {
  #state = Object.freeze({ revision: "0", view: EMPTY_VIEW });
  #stated = false;
  #listeners = new Set();
  #queue = Promise.resolve();
  #viewpoints;

  constructor(viewpoints = [{ id: "world", label: "World" }]) {
    if (
      !Array.isArray(viewpoints) ||
      viewpoints.length < 1 ||
      viewpoints.length > 257 ||
      viewpoints[0]?.id !== "world" ||
      new Set(viewpoints.map((item) => item.id)).size !== viewpoints.length ||
      viewpoints.some(
        (item) =>
          typeof item.id !== "string" ||
          item.id.length === 0 ||
          item.id.length > 256 ||
          typeof item.label !== "string" ||
          item.label.length === 0 ||
          item.label.length > 256 ||
          item.id === "restore",
      )
    ) {
      invalid("viewpoints must identify the world and at most 256 distinct declared robots");
    }
    this.#viewpoints = Object.freeze(
      viewpoints
        .map(({ id, label }) => Object.freeze({ id, label }))
        .sort((a, b) => {
          if (a.id === "world") {
            return -1;
          }
          if (b.id === "world") {
            return 1;
          }
          return (
            a.label.localeCompare(b.label, "zh-CN", { numeric: true, sensitivity: "base" }) ||
            a.id.localeCompare(b.id)
          );
        }),
    );
  }

  // eslint-disable-next-line no-restricted-syntax -- Read-only product menu is part of the control interface.
  get viewpoints() {
    return this.#viewpoints;
  }

  /** Decimal-string revision of this process's desired view, "0" before its first statement. */
  // eslint-disable-next-line no-restricted-syntax -- Read-only property is part of the native control interface.
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
      view.viewpoint &&
      view.viewpoint.id !== "restore" &&
      !this.#viewpoints.some((item) => item.id === view.viewpoint.id)
    ) {
      invalid("viewpoint is not declared by this viewer");
    }
    if (
      !Object.is(expectedRevision, undefined) &&
      (typeof expectedRevision !== "string" || !DECIMAL.test(expectedRevision))
    ) {
      invalid("expectedRevision must be a decimal string");
    }
    const work = this.#queue.then(() => {
      if (!Object.is(expectedRevision, undefined) && expectedRevision !== this.#state.revision) {
        throw new ViewError("conflict", "view revision conflict", 409);
      }
      if (this.#stated && !view.viewpoint && isDeepStrictEqual(this.#state.view, view)) {
        return { ...this.#state, unchanged: true };
      }
      if (view.viewpoint) {
        Object.freeze(view.viewpoint);
      }
      if (view.visibleSurfaces) {
        Object.freeze(view.visibleSurfaces);
      }
      this.#state = Object.freeze({
        revision: String(BigInt(this.#state.revision) + 1n),
        view: Object.freeze(view),
      });
      this.#stated = true;
      for (const listener of this.#listeners) {
        listener(this.#state);
      }
      return { ...this.#state, unchanged: false };
    });
    this.#queue = work.catch(() => {});
    return await work;
  }
}

module.exports = { ViewError, SURFACES, EMPTY_VIEW, ViewStore, normalizeView };
