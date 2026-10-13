// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { TEST_MCAP_URL } from "../../../fixtures/urls";
import { PlayerControls } from "../../../page-objects";

test("should open an MCAP file via URL", { tag: "@smoke" }, async ({ page }) => {
  const player = new PlayerControls(page);

  // Serve the checked-in MCAP through the remote-file protocol; this smoke test
  // must not depend on the availability of an external demo-file proxy.
  const bytes = await readFile(path.resolve("e2e/fixtures/assets/example.mcap"));
  await page.route(TEST_MCAP_URL, async (route) => {
    const range = route.request().headers()["range"];
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    await route.fulfill({
      status: match ? 206 : 200,
      headers: {
        "content-type": "application/octet-stream",
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "Content-Range, Accept-Ranges, Content-Length",
        ...(match ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
      body: bytes.subarray(start, end + 1),
    });
  });

  // Given
  await page.goto(`/?ds=remote-file&ds.url=${TEST_MCAP_URL}`);

  // When
  // TextMiddleTruncate splits a long URL across two nodes and puts the full
  // value on title. Matching the prefix by text hits both nodes.
  const sourceTitle = page.getByTitle(TEST_MCAP_URL);
  const playButton = page.getByRole("button", { name: "Play", exact: true });
  const pauseButton = page.getByRole("button", {
    name: "Pause",
    exact: true,
  });

  // Then
  await expect(sourceTitle).toBeVisible();
  await expect(playButton).toBeEnabled();

  // When
  await player.getProgressPlot().waitFor({ state: "hidden" });
  await playButton.click();

  // Then
  await expect(playButton).not.toBeVisible();
  await expect(pauseButton).toBeEnabled();
});
