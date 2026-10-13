/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, render, waitFor } from "@testing-library/react";
import { readFileSync } from "fs";
import path from "path";
import { useMedia } from "react-use";

import { useAppConfigurationValue } from "@lichtblick/suite-base/hooks";

import { ColorSchemeThemeProvider } from "./ColorSchemeThemeProvider";
import { XGC2_EMBED_CHANNEL, XGC2_EMBED_VERSION } from "./EmbeddedWorkspaceProtocol";

jest.mock("react-use", () => ({
  useMedia: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/hooks", () => ({
  useAppConfigurationValue: jest.fn(),
}));

const theme = {
  channel: XGC2_EMBED_CHANNEL,
  version: XGC2_EMBED_VERSION,
  sender: "xgc2",
  type: "theme",
  colorScheme: "light",
  backgroundColor: "#ffffff",
};

function dispatchTheme(data: unknown = theme, origin = window.location.origin): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin,
      source: window.parent,
    }),
  );
}

const DARK_SURFACE = "#121212";

describe("ColorSchemeThemeProvider", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    document.documentElement.removeAttribute("data-xgc2-embed");
    document.documentElement.removeAttribute("data-color-mode");
    document.documentElement.style.backgroundColor = "";
    document.body.style.backgroundColor = "";
    jest.mocked(useMedia).mockReturnValue(true);
    jest.mocked(useAppConfigurationValue).mockReturnValue(["dark", jest.fn()] as never);
  });

  it("keeps a standalone document on the selected scheme", async () => {
    document.documentElement.style.backgroundColor = DARK_SURFACE;
    document.body.style.backgroundColor = DARK_SURFACE;
    const kept = document.body.style.backgroundColor;
    render(
      <ColorSchemeThemeProvider>
        <span>standalone</span>
      </ColorSchemeThemeProvider>,
      { container: document.getElementById("root")! },
    );
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-color-mode")).toBe("dark");
    });
    expect(document.documentElement.hasAttribute("data-xgc2-embed")).toBe(false);
    expect(document.getElementById("root")!.style.visibility).toBe("");
    expect(document.documentElement.style.backgroundColor).toBe(kept);
    expect(document.body.style.backgroundColor).toBe(kept);
    act(() => {
      dispatchTheme();
    });
    expect(document.documentElement.getAttribute("data-color-mode")).toBe("dark");
    expect(document.documentElement.style.backgroundColor).toBe(kept);
  });

  it("keeps the embedded surface transparent until an authenticated host theme arrives", async () => {
    document.documentElement.style.backgroundColor = DARK_SURFACE;
    document.body.style.backgroundColor = DARK_SURFACE;
    const view = render(
      <ColorSchemeThemeProvider embedded>
        <span>embedded</span>
      </ColorSchemeThemeProvider>,
      { container: document.getElementById("root")! },
    );
    expect(document.documentElement.getAttribute("data-xgc2-embed")).toBe("pending");
    expect(document.documentElement.style.backgroundColor).toBe("transparent");
    expect(document.body.style.backgroundColor).toBe("transparent");
    expect(document.getElementById("root")!.style.visibility).toBe("hidden");
    expect(document.body.textContent).toContain("embedded");
    act(() => {
      dispatchTheme(theme, "https://foreign.invalid");
      dispatchTheme({ ...theme, colorScheme: "system" });
      dispatchTheme({ ...theme, sender: "stranger" });
    });
    expect(document.documentElement.getAttribute("data-xgc2-embed")).toBe("pending");
    expect(document.documentElement.style.backgroundColor).toBe("transparent");
    expect(document.body.style.backgroundColor).toBe("transparent");
    expect(document.getElementById("root")!.style.visibility).toBe("hidden");
    expect(view.container.isConnected).toBe(true);
    act(() => {
      dispatchTheme();
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-color-mode")).toBe("light");
    });
    expect(document.documentElement.hasAttribute("data-xgc2-embed")).toBe(false);
    expect(document.documentElement.style.backgroundColor).toBe("");
    expect(document.body.style.backgroundColor).toBe("");
    expect(document.getElementById("root")!.style.visibility).toBe("");
    expect(view.container.isConnected).toBe(true);
  });
});

describe("embedded pending startup surface", () => {
  const source = readFileSync(
    path.join(__dirname, "../../../suite-web/src/webpackConfigs.ts"),
    "utf8",
  );
  const pendingRule = source.slice(
    source.indexOf('html[data-xgc2-embed="pending"]'),
    source.indexOf("</style>"),
  );

  it("makes pending html and body transparent without changing the standalone startup colors", () => {
    expect(pendingRule).toContain('html[data-xgc2-embed="pending"],');
    expect(pendingRule).toContain('html[data-xgc2-embed="pending"] body');
    expect(pendingRule).toContain("background-color: transparent;");
    expect(source).toContain("@media (prefers-color-scheme: dark)");
    expect(source).toContain("background-color: ${palette.light.background?.default};");
    expect(source).toContain("background-color: ${palette.dark.background?.default};");
    const outsidePending = source.slice(0, source.indexOf('html[data-xgc2-embed="pending"]'));
    expect(outsidePending).not.toContain("html, body");
  });
});
