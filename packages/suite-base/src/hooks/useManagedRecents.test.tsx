/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, renderHook } from "@testing-library/react";

import useManagedRecents from "./useManagedRecents";

let mockMetadata: unknown[] = [];
const mockCommit = jest.fn(async (changes: { value: unknown[] }[]) => {
  mockMetadata = JSON.parse(JSON.stringify(changes[0]!.value)!) as unknown[];
});
jest.mock("@lichtblick/suite-base/services/persistence/ManagedPersistence", () => ({
  getManagedDocumentStore: () => ({
    get: () => JSON.parse(JSON.stringify(mockMetadata)!) as unknown[],
    commit: mockCommit,
  }),
}));
beforeEach(() => {
  mockMetadata = [];
  mockCommit.mockClear();
});
it("a fresh session restores recent file identity and requires a new handle grant", async () => {
  const first = renderHook(() => useManagedRecents());
  const handle = {
    kind: "file",
    name: "trip.mcap",
    getFile: jest.fn(),
  } as unknown as FileSystemFileHandle;
  await act(async () => {
    first.result.current.addRecent({
      type: "file",
      title: "trip.mcap",
      sourceId: "mcap",
      handles: [handle],
    });
    await first.result.current.save();
  });
  expect(first.result.current.recents[0]).toMatchObject({ handles: [handle] });
  expect(mockMetadata[0]).not.toHaveProperty("handles");
  first.unmount();
  const fresh = renderHook(() => useManagedRecents());
  expect(fresh.result.current.recents[0]).toMatchObject({
    type: "file",
    title: "trip.mcap",
    handles: [],
  });
});
it("rapid recent additions wait for the previous acknowledgement before another save", async () => {
  let acknowledged!: () => void;
  mockCommit.mockImplementationOnce(async (changes) => {
    await new Promise<void>((resolve) => {
      acknowledged = resolve;
    });
    mockMetadata = JSON.parse(JSON.stringify(changes[0]!.value)!) as unknown[];
  });
  const recent = renderHook(() => useManagedRecents());
  act(() => {
    recent.result.current.addRecent({
      type: "connection",
      title: "first",
      sourceId: "ws",
      extra: { url: "ws://first" },
    });
    recent.result.current.addRecent({
      type: "connection",
      title: "second",
      sourceId: "ws",
      extra: { url: "ws://second" },
    });
  });
  expect(mockCommit).toHaveBeenCalledTimes(1);
  expect(recent.result.current.recents).toEqual([]);
  await act(async () => {
    acknowledged();
    await recent.result.current.save();
  });
  expect(mockCommit).toHaveBeenCalledTimes(2);
  expect(recent.result.current.recents.map((record) => record.title)).toEqual(["second", "first"]);
});
