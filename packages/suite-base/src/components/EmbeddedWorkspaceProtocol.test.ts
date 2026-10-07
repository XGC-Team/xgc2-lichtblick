/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  embeddedParentOrigin,
  isXgc2EmbeddedVisibilityMessage,
} from "./EmbeddedWorkspaceProtocol";

describe("isXgc2EmbeddedVisibilityMessage", () => {
  it("accepts only the exact versioned visibility shape", () => {
    expect(
      isXgc2EmbeddedVisibilityMessage({
        channel: "xgc2.lichtblick.embed",
        version: 2,
        sender: "xgc2",
        type: "visibility",
        visible: false,
      }),
    ).toBe(true);
    expect(
      isXgc2EmbeddedVisibilityMessage({
        channel: "xgc2.lichtblick.embed",
        version: 2,
        sender: "xgc2",
        type: "visibility",
        visible: true,
        extra: true,
      }),
    ).toBe(false);
    expect(
      isXgc2EmbeddedVisibilityMessage({
        channel: "xgc2.lichtblick.embed",
        version: 2,
        sender: "lichtblick",
        type: "visibility",
        visible: true,
      }),
    ).toBe(false);
    expect(isXgc2EmbeddedVisibilityMessage(undefined)).toBe(false);
    expect(isXgc2EmbeddedVisibilityMessage([])).toBe(false);
  });
});

describe("embeddedParentOrigin", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("falls back to the viewer origin for a classic same-origin embed", () => {
    expect(embeddedParentOrigin()).toBe(window.location.origin);
  });

  it("reads the declared parent origin and rejects invalid values", () => {
    window.history.pushState({}, "", "/?xgc2ParentOrigin=http%3A%2F%2F127.0.0.1%3A5174");
    expect(embeddedParentOrigin()).toBe("http://127.0.0.1:5174");
    window.history.pushState({}, "", "/?xgc2ParentOrigin=not-a-url");
    expect(embeddedParentOrigin()).toBe(window.location.origin);
  });
});
