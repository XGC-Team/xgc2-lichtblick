/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
import { render } from "@testing-library/react";

import { StudioLogsSettingsProvider } from "./StudioLogsSettingsProvider";

const mockGet = jest.fn().mockReturnValue({ globalLevel: "warn", disabledChannels: [] });
const mockCommit = jest.fn().mockResolvedValue({});
jest.mock("@lichtblick/suite-base/services/persistence/ManagedPersistence", () => ({
  getManagedDocumentStore: () => ({ get: mockGet, commit: mockCommit }),
}));
it("loads managed log preferences without creating a second browser copy", () => {
  const write = jest.spyOn(Storage.prototype, "setItem");
  const view = render(
    <StudioLogsSettingsProvider>
      <div />
    </StudioLogsSettingsProvider>,
  );
  expect(mockGet).toHaveBeenCalledWith("workspace", "log-settings");
  expect(mockCommit).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  view.unmount();
});
