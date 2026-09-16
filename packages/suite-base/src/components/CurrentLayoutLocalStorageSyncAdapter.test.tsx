/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, render } from "@testing-library/react";

import {
  CurrentLayoutLocalStorageSyncAdapter,
  selectLayoutData,
  selectLayoutId,
} from "@lichtblick/suite-base/components/CurrentLayoutLocalStorageSyncAdapter";
import { LOCAL_STORAGE_STUDIO_LAYOUT_KEY } from "@lichtblick/suite-base/constants/browserStorageKeys";
import {
  LayoutData,
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import MockCurrentLayoutProvider from "@lichtblick/suite-base/providers/CurrentLayoutProvider/MockCurrentLayoutProvider";
import MockLayoutManager from "@lichtblick/suite-base/services/LayoutManager/MockLayoutManager";
import LayoutBuilder from "@lichtblick/suite-base/testing/builders/LayoutBuilder";

jest.mock("@lichtblick/suite-base/context/CurrentLayoutContext", () => {
  const originalModule = jest.requireActual("@lichtblick/suite-base/context/CurrentLayoutContext");
  return {
    __esModule: true,
    ...originalModule,
    useCurrentLayoutActions: jest.fn(),
    useCurrentLayoutSelector: jest.fn(),
  };
});

jest.mock("@lichtblick/suite-base/context/LayoutManagerContext", () => {
  const originalModule = jest.requireActual("@lichtblick/suite-base/context/LayoutManagerContext");
  return {
    __esModule: true,
    ...originalModule,
    useLayoutManager: jest.fn(),
  };
});

describe("CurrentLayoutLocalStorageSyncAdapter", () => {
  const mockGetCurrentLayoutState = jest.fn();
  const mockLayoutManager = new MockLayoutManager();
  const mockLayoutData: LayoutData = LayoutBuilder.layout().baseline.data;
  const mockLayoutId = LayoutBuilder.layoutId();

  beforeEach(() => {
    jest.clearAllMocks();
    (useCurrentLayoutActions as jest.Mock).mockReturnValue({
      getCurrentLayoutState: mockGetCurrentLayoutState,
    });
    (useCurrentLayoutSelector as jest.Mock).mockImplementation((selector) => {
      if (selector === selectLayoutData) {
        return mockLayoutData;
      }
      if (selector === selectLayoutId) {
        return mockLayoutId;
      }
      return undefined;
    });
    (useLayoutManager as jest.Mock).mockReturnValue(mockLayoutManager);
    localStorage.clear();
  });

  function renderComponent() {
    const component = (
      <MockCurrentLayoutProvider>
        <CurrentLayoutLocalStorageSyncAdapter />;
      </MockCurrentLayoutProvider>
    );
    const renderObj = render(component);

    return {
      ...renderObj,
      rerender: () => {
        renderObj.rerender(component);
      },
    };
  }

  it("saves layout data to localStorage when it changes", async () => {
    // Given
    renderComponent();

    // When
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300)); // Wait for debounce
    });

    // Then
    const storedData = localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY);
    expect(storedData).toBe(JSON.stringify(mockLayoutData));
  });

  it("sends new layout data to layoutManager after initial load", async () => {
    // Given
    mockGetCurrentLayoutState.mockReturnValue({
      selectedLayout: { id: mockLayoutId, data: mockLayoutData },
    });

    // When
    const { rerender } = renderComponent();

    // Verify initial call was skipped
    expect(mockLayoutManager.updateLayout).not.toHaveBeenCalled();

    // Now simulate a data change by updating the mock to return different data
    const modifiedData = { ...mockLayoutData, modified: true };

    (useCurrentLayoutSelector as jest.Mock).mockImplementation((selector) => {
      if (selector === selectLayoutData) {
        return modifiedData;
      }
      if (selector === selectLayoutId) {
        return mockLayoutId;
      }
      return undefined;
    });

    // Force a re-render to trigger useAsync with new data
    await act(async () => {
      rerender();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 300)); // Wait for debounce
    });

    // Then - should be called on the second execution
    expect(mockLayoutManager.updateLayout).toHaveBeenCalledWith({
      id: mockLayoutId,
      data: modifiedData,
    });
  });

  describe("when requestIdleCallback is available but never fires", () => {
    const requestIdleCallbackMock = jest.fn().mockReturnValue(1);
    const cancelIdleCallbackMock = jest.fn();

    beforeEach(() => {
      Object.defineProperty(window, "requestIdleCallback", {
        writable: true,
        configurable: true,
        value: requestIdleCallbackMock,
      });
      Object.defineProperty(window, "cancelIdleCallback", {
        writable: true,
        configurable: true,
        value: cancelIdleCallbackMock,
      });
    });

    afterEach(() => {
      delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
      delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    });

    it("flushes the pending layout to localStorage on beforeunload", async () => {
      // Given
      renderComponent();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300)); // Wait for debounce
      });

      // The write was deferred to the idle callback, which has not run
      expect(requestIdleCallbackMock).toHaveBeenCalled();
      expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY)).toBeNull();

      // When
      act(() => {
        window.dispatchEvent(new Event("beforeunload"));
      });

      // Then
      expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY)).toBe(
        JSON.stringify(mockLayoutData),
      );
    });

    it("flushes the pending layout to localStorage on unmount", async () => {
      // Given
      const { unmount } = renderComponent();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300)); // Wait for debounce
      });

      expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY)).toBeNull();

      // When
      unmount();

      // Then
      expect(cancelIdleCallbackMock).toHaveBeenCalled();
      expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY)).toBe(
        JSON.stringify(mockLayoutData),
      );
    });
  });
});
