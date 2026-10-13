// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import type { Page } from "@playwright/test";

import { CoreUiDocumentServer } from "../../packages/suite-base/src/services/persistence/test/CoreUiDocumentServer";

/** Exercise the current Core document protocol without a live station dependency. */
export async function installCoreUiDocuments(page: Page): Promise<void> {
  const server = new CoreUiDocumentServer();
  await page.route("**/api/ui-documents/lichtblick/**", async (route) => {
    const request = route.request();
    const response = await server.fetch(request.url(), {
      method: request.method(),
      headers: request.headers(),
      body: request.postData() ?? undefined,
      credentials: "same-origin",
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}
