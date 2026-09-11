/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, renderHook } from "@testing-library/react";

import { useCurrentLayoutActions } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { useLayoutNavigation } from "@lichtblick/suite-base/hooks/useLayoutNavigation";
import * as filePicker from "@lichtblick/suite-base/util/showOpenFilePicker";
import { BasicBuilder } from "@lichtblick/test-builders";

import { useLayoutTransfer } from "./useLayoutTransfer";
import { useAnalytics } from "../context/AnalyticsContext";
import { useLayoutManager } from "../context/LayoutManagerContext";

jest.mock("notistack", () => ({
  useSnackbar: () => ({ enqueueSnackbar: jest.fn() }),
}));

jest.mock("@lichtblick/suite-base/context/CurrentLayoutContext", () => ({
  useCurrentLayoutActions: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/context/LayoutManagerContext", () => ({
  useLayoutManager: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/hooks/useLayoutNavigation", () => ({
  useLayoutNavigation: jest.fn(),
}));

jest.mock("../context/AnalyticsContext", () => ({
  useAnalytics: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/util/showOpenFilePicker");

jest.mock("react-use", () => ({
  ...jest.requireActual("react-use"),
  useMountedState: () => () => true,
}));

describe("useLayoutTransfer", () => {
  const saveNewLayoutMock = jest.fn();
  const getCurrentLayoutStateMock = jest.fn();
  const onSelectLayoutMock = jest.fn();
  const promptForUnsavedChangesMock = jest.fn();
  const logEventMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    (useLayoutManager as jest.Mock).mockReturnValue({
      saveNewLayout: saveNewLayoutMock,
    });

    (useCurrentLayoutActions as jest.Mock).mockReturnValue({
      getCurrentLayoutState: getCurrentLayoutStateMock,
    });
    getCurrentLayoutStateMock.mockReturnValue({ selectedLayout: undefined });

    (useLayoutNavigation as jest.Mock).mockReturnValue({
      promptForUnsavedChanges: promptForUnsavedChangesMock,
      onSelectLayout: onSelectLayoutMock,
    });

    (useAnalytics as jest.Mock).mockReturnValue({
      logEvent: logEventMock,
    });
  });

  it("should import a layout and call onSelectLayout", async () => {
    promptForUnsavedChangesMock.mockResolvedValue(true);
    const content = JSON.stringify({ data: BasicBuilder.string() }) ?? "";
    const mockFile = new File([content], "test-layout.json", {
      type: "application/json",
    });

    mockFile.text = async () => content;

    (filePicker.default as jest.Mock).mockResolvedValue([
      {
        getFile: async () => mockFile,
      },
    ]);

    saveNewLayoutMock.mockResolvedValue({
      id: "123",
      name: "test-layout",
      data: content,
    });

    const { result } = renderHook(() => useLayoutTransfer());

    await act(async () => {
      await result.current.importLayout();
    });

    expect(saveNewLayoutMock).toHaveBeenCalled();
    expect(onSelectLayoutMock).toHaveBeenCalled();
    expect(logEventMock).toHaveBeenCalled();
  });

  it("restores managed followTf from the current layout while keeping imported camera state", async () => {
    getCurrentLayoutStateMock.mockReturnValue({
      selectedLayout: {
        data: {
          configById: {
            "3D!xgc2": { followTf: "world", topics: { "/xgc/tf": { visible: true } } },
          },
        },
      },
    });
    const content =
      JSON.stringify({
        configById: { "3D!imported": { followTf: "map", cameraState: { distance: 3 } } },
        layout: "3D!imported",
      }) ?? "";
    const mockFile = new File([content], "imported.json", { type: "application/json" });
    mockFile.text = async () => content;
    (filePicker.default as jest.Mock).mockResolvedValue([{ getFile: async () => mockFile }]);
    saveNewLayoutMock.mockResolvedValue({ id: "456", name: "imported", data: {} });

    const { result } = renderHook(() => useLayoutTransfer());
    await act(async () => {
      await result.current.importLayout();
    });

    expect(saveNewLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          layout: "3D!imported",
          configById: {
            "3D!imported": expect.objectContaining({
              followTf: "world",
              cameraState: { distance: 3 },
              topics: { "/xgc/tf": { visible: true } },
            }),
          },
        }),
      }),
    );
  });

  it("installs a Core layoutUrl over parked ugv3 followTf", async () => {
    getCurrentLayoutStateMock.mockReturnValue({
      selectedLayout: {
        data: {
          configById: {
            "3D!xgc2": {
              followTf: "xgc/robots/ugv1/base_link",
              layers: {
                "xgc2-urdf-ugv2": { framePrefix: "xgc/robots/ugv3/" },
              },
              cameraState: { distance: 5 },
            },
          },
        },
      },
    });
    const content =
      JSON.stringify({
        configById: {
          "3D!xgc2": {
            followTf: "world",
            followMode: "follow-none",
            layers: {
              "xgc2-urdf-ugv2": {
                layerId: "foxglove.Urdf",
                framePrefix: "xgc/robots/ugv2/",
                parameter: "/ugv2/visual_robot_description",
              },
            },
            cameraState: { distance: 12 },
          },
        },
        layout: "3D!xgc2",
      }) ?? "";
    const mockFile = new File([content], "layout.json", { type: "application/json" });
    mockFile.text = async () => content;
    saveNewLayoutMock.mockResolvedValue({ id: "core", name: "layout", data: {} });

    const { result } = renderHook(() => useLayoutTransfer());
    await act(async () => {
      await result.current.parseAndInstallLayout(mockFile, "local", { managedAuthority: true });
    });

    expect(saveNewLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          layout: "3D!xgc2",
          configById: {
            "3D!xgc2": expect.objectContaining({
              followTf: "world",
              followMode: "follow-none",
              cameraState: { distance: 5 },
              layers: {
                "xgc2-urdf-ugv2": expect.objectContaining({
                  framePrefix: "xgc/robots/ugv2/",
                  parameter: "/ugv2/visual_robot_description",
                }),
              },
            }),
          },
        }),
      }),
    );
  });
});
