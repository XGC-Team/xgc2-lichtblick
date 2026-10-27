/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { useMediaQuery } from "@mui/material";
import { act, render } from "@testing-library/react";
import * as THREE from "three";

import { resetEmbeddedHostVisibilityForTests } from "@lichtblick/suite-base/components/EmbeddedParkedSignal";
import { XGC2_HOST_VISIBILITY_EVENT } from "@lichtblick/suite-base/components/EmbeddedWorkspaceProtocol";

import Snow from "./Snow";

jest.mock("@mui/material", () => ({ useMediaQuery: jest.fn() }));
jest.mock("three", () => ({
  ...jest.requireActual<typeof import("three")>("three"),
  WebGLRenderer: jest.fn(() => ({
    domElement: globalThis.document.createElement("canvas"),
    setPixelRatio: jest.fn(),
    setSize: jest.fn(),
    render: jest.fn(),
    dispose: jest.fn(),
  })),
}));

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

function setDocumentVisibility(visibility: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
  document.dispatchEvent(new Event("visibilitychange"));
}
function setHostVisibility(visibility: "visible" | "hidden"): void {
  window.dispatchEvent(
    new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: visibility === "visible" } }),
  );
}
function frame(now: number): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) {
    callback(now);
  }
}

beforeEach(() => {
  jest.mocked(THREE.WebGLRenderer).mockClear();
  frames.clear();
  nextFrame = 0;
  resetEmbeddedHostVisibilityForTests();
  setDocumentVisibility("visible");
  jest.mocked(useMediaQuery).mockReturnValue(false);
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
});
afterEach(() => {
  if (originalVisibility) {
    Object.defineProperty(document, "visibilityState", originalVisibility);
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
  resetEmbeddedHostVisibilityForTests();
});

it("retains one canvas, freezes elapsed motion while host or document is hidden, and releases its frame", () => {
  const view = render(<Snow effect="snow" />);
  const renderer = jest.mocked(THREE.WebGLRenderer).mock.results.at(-1)!.value as {
    render: jest.Mock<void, [THREE.Scene, THREE.Camera]>;
    dispose: jest.Mock<void, []>;
  };
  expect(frames.size).toBe(1);
  act(() => {
    frame(100);
    frame(180);
  });
  const scene = jest.mocked(renderer.render).mock.lastCall![0] as THREE.Scene;
  const material = (scene.children[0] as THREE.Points).material as THREE.ShaderMaterial;
  expect(material.uniforms.time!.value).toBe(0.08);
  act(() => {
    setHostVisibility("hidden");
  });
  expect(frames.size).toBe(0);
  act(() => {
    setDocumentVisibility("hidden");
    setHostVisibility("visible");
  });
  expect(frames.size).toBe(0);
  act(() => {
    setDocumentVisibility("visible");
  });
  expect(frames.size).toBe(1);
  act(() => {
    frame(10_000);
  });
  expect(material.uniforms.time!.value).toBe(0.08);
  expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
  expect(THREE.WebGLRenderer).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(frames.size).toBe(0);
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

it("honors reduced motion without creating a second frame owner or replaying elapsed hidden time", () => {
  jest.mocked(useMediaQuery).mockReturnValue(true);
  const view = render(<Snow effect="confetti" />);
  expect(frames.size).toBe(0);
  jest.mocked(useMediaQuery).mockReturnValue(false);
  view.rerender(<Snow effect="confetti" />);
  expect(frames.size).toBe(1);
  jest.mocked(useMediaQuery).mockReturnValue(true);
  view.rerender(<Snow effect="confetti" />);
  expect(frames.size).toBe(0);
  expect(THREE.WebGLRenderer).toHaveBeenCalledTimes(1);
  view.unmount();
});
