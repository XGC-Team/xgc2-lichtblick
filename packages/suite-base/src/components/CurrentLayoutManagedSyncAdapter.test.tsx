/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, fireEvent, render } from "@testing-library/react";

import { CurrentLayoutManagedSyncAdapter } from "./CurrentLayoutManagedSyncAdapter";

let mockCurrent = {
  id: "view",
  data: { configById: { "3D!1": { cameraState: { distance: 20 } } } },
};
let mockState: { pending: number; error?: Error; uncertainRequestId?: string } = { pending: 0 };
const mockListeners = new Set<() => void>();
const mockUpdate = jest.fn();
const mockSetError = jest.fn();
const mockActions = {
  getCurrentLayoutState: () => ({ selectedLayout: mockCurrent }),
  setSelectedLayoutId: jest.fn(),
};
jest.mock("@lichtblick/suite-base/context/CurrentLayoutContext", () => ({
  useCurrentLayoutSelector: () => mockCurrent,
  useCurrentLayoutActions: () => mockActions,
}));
const mockManager = {
  getLayout: async () => ({
    baseline: { data: { configById: { "3D!1": { cameraState: { distance: 20 } } } } },
  }),
  updateLayout: mockUpdate,
  setError: mockSetError,
};
jest.mock("@lichtblick/suite-base/context/LayoutManagerContext", () => ({
  useLayoutManager: () => mockManager,
}));
const mockStore = {
  // eslint-disable-next-line no-restricted-syntax -- The mock exposes the observable commit snapshot.
  get state() {
    return mockState;
  },
  records: () => [
    {
      value: {
        id: "view",
        baseline: { data: { configById: { "3D!1": { cameraState: { distance: 20 } } } } },
      },
    },
  ],
  get: jest.fn(),
  subscribe(listener: () => void) {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
};
jest.mock("@lichtblick/suite-base/services/persistence/ManagedPersistence", () => ({
  getManagedDocumentStore: () => mockStore,
}));
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockState = { pending: 0 };
  mockCurrent = { id: "view", data: { configById: { "3D!1": { cameraState: { distance: 20 } } } } };
});
afterEach(() => {
  jest.useRealTimers();
  mockListeners.clear();
});
it("pending debounce and unresolved receipt stay silent, and unload never flushes a network write", async () => {
  const view = render(<CurrentLayoutManagedSyncAdapter />);
  await act(async () => {});
  mockCurrent = {
    ...mockCurrent,
    data: { configById: { "3D!1": { cameraState: { distance: 7 } } } },
  };
  view.rerender(<CurrentLayoutManagedSyncAdapter />);
  expect(view.container).toBeEmptyDOMElement();
  const unload = new Event("beforeunload", { cancelable: true });
  fireEvent(window, unload);
  expect(unload.defaultPrevented).toBe(true);
  expect(mockUpdate).not.toHaveBeenCalled();
  mockUpdate.mockImplementation(async () => {
    mockState = { pending: 1 };
    for (const listener of mockListeners) {
      listener();
    }
    return await new Promise(() => {});
  });
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
  expect(mockUpdate).toHaveBeenCalledWith({ id: "view", data: mockCurrent.data });
  expect(view.container).toBeEmptyDOMElement();
  view.unmount();
  expect(mockUpdate).toHaveBeenCalledTimes(1);
});
it("camera changes arriving during a save coalesce after its receipt", async () => {
  let committed!: () => void;
  mockUpdate
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        committed = resolve;
      });
    })
    .mockResolvedValue(undefined);
  const view = render(<CurrentLayoutManagedSyncAdapter />);
  await act(async () => {});
  for (const distance of [7, 5, 3]) {
    mockCurrent = {
      ...mockCurrent,
      data: { configById: { "3D!1": { cameraState: { distance } } } },
    };
    view.rerender(<CurrentLayoutManagedSyncAdapter />);
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
  }
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  await act(async () => {
    committed();
  });
  expect(mockUpdate).toHaveBeenCalledTimes(2);
  expect(mockUpdate).toHaveBeenLastCalledWith({ id: "view", data: mockCurrent.data });
});
it("switching within the debounce window saves the previous layout's latest camera", async () => {
  const view = render(<CurrentLayoutManagedSyncAdapter />);
  await act(async () => {});
  const data = { configById: { "3D!1": { cameraState: { distance: 7 } } } };
  mockCurrent = { id: "view", data };
  view.rerender(<CurrentLayoutManagedSyncAdapter />);
  await act(async () => {
    jest.advanceTimersByTime(100);
  });
  mockCurrent = {
    id: "other",
    data: { configById: { "3D!1": { cameraState: { distance: 20 } } } },
  };
  view.rerender(<CurrentLayoutManagedSyncAdapter />);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(mockUpdate).toHaveBeenCalledWith({ id: "view", data });
  expect(mockUpdate).not.toHaveBeenCalledWith({ id: "view", data: mockCurrent.data });
});
