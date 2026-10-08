// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { enqueueSnackbar } from "notistack";
import path from "path";
import { useCallback } from "react";
import { useMountedState } from "react-use";

import {
  LayoutData,
  LayoutID,
  useCurrentLayoutActions,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import useCallbackWithToast from "@lichtblick/suite-base/hooks/useCallbackWithToast";
import { useLayoutNavigation } from "@lichtblick/suite-base/hooks/useLayoutNavigation";
import { Layout } from "@lichtblick/suite-base/services/ILayoutStorage";
import { validateManagedLayoutData } from "@lichtblick/suite-base/services/persistence/validateManagedLayout";
import { Namespace } from "@lichtblick/suite-base/types";
import { downloadTextFile } from "@lichtblick/suite-base/util/download";
import showOpenFilePicker from "@lichtblick/suite-base/util/showOpenFilePicker";
import {
  mergeManagedLayoutFromUrl,
  sanitizeImportedLayoutData,
  type Xgc2LayoutScope,
} from "@lichtblick/suite-base/util/xgcManagedLayoutImport";

import { useAnalytics } from "../context/AnalyticsContext";
import { useLayoutManager } from "../context/LayoutManagerContext";
import { AppEvent } from "../services/IAnalytics";

export type ParseAndInstallLayoutOptions = {
  managedAuthority?: boolean;
  xgc2LayoutScope?: Xgc2LayoutScope;
  previousScopedLayout?: LayoutData;
  replaceIds?: readonly LayoutID[];
};

type UseLayoutTransfer = {
  importLayout: () => Promise<void>;
  exportLayout: () => Promise<void>;
  parseAndInstallLayout: (
    file: File,
    namespace?: Namespace,
    options?: ParseAndInstallLayoutOptions,
  ) => Promise<Layout | undefined>;
};

export function useLayoutTransfer(): UseLayoutTransfer {
  const isMounted = useMountedState();
  const layoutManager = useLayoutManager();
  const analytics = useAnalytics();
  const { onSelectLayout } = useLayoutNavigation();
  const { getCurrentLayoutState } = useCurrentLayoutActions();

  const parseAndInstallLayout = useCallback(
    async (file: File, namespace: Namespace = "local", options?: ParseAndInstallLayoutOptions) => {
      const layoutName = path.basename(file.name, path.extname(file.name));
      const content = await file.text();

      if (!isMounted()) {
        return;
      }

      let parsedState: unknown;
      try {
        parsedState = JSON.parse(content);
      } catch (err: unknown) {
        enqueueSnackbar(`${file.name} is not a valid layout: ${(err as Error).message}`, {
          variant: "error",
        });
        return;
      }

      if (typeof parsedState !== "object" || !parsedState) {
        enqueueSnackbar(`${file.name} is not a valid layout`, { variant: "error" });
        return;
      }

      validateManagedLayoutData(parsedState);
      const parked = options?.xgc2LayoutScope
        ? options.previousScopedLayout
        : getCurrentLayoutState().selectedLayout?.data;
      const data = (
        options?.managedAuthority === true
          ? mergeManagedLayoutFromUrl(parsedState, parked, options.xgc2LayoutScope)
          : sanitizeImportedLayoutData(parsedState, parked)
      ) as LayoutData;
      const newLayout = await layoutManager.saveNewLayout({
        name: layoutName,
        data,
        permission: namespace === "org" ? "ORG_WRITE" : "CREATOR_WRITE",
        activate: true,
        replaceIds: options?.replaceIds,
      });

      void onSelectLayout(newLayout);

      return newLayout;
    },
    [getCurrentLayoutState, isMounted, layoutManager, onSelectLayout],
  );

  const importLayout = useCallbackWithToast(async () => {
    const fileHandles = await showOpenFilePicker({
      multiple: true,
      excludeAcceptAllOption: false,
      types: [
        {
          description: "JSON Files",
          accept: {
            "application/json": [".json"],
          },
        },
      ],
    });

    if (fileHandles.length === 0) {
      return;
    }

    if (fileHandles.length > 255) {
      throw new Error("Import requires at most 255 layouts");
    }
    const entries = [];
    const parked = getCurrentLayoutState().selectedLayout?.data;
    for (const fileHandle of fileHandles) {
      const file = await fileHandle.getFile();
      if (file.size > 2 * 1024 * 1024) {
        throw new Error("Layout file exceeds 2 MiB");
      }
      const parsed: unknown = JSON.parse(await file.text());
      validateManagedLayoutData(parsed);
      entries.push({
        name: path.basename(file.name, path.extname(file.name)),
        data: sanitizeImportedLayoutData(parsed, parked) as LayoutData,
      });
    }

    if (!isMounted()) {
      return;
    }

    const saved = await layoutManager.importLayoutFiles(entries);
    const selected = saved.at(-1);
    if (selected) {
      await onSelectLayout(selected);
    }

    void analytics.logEvent(AppEvent.LAYOUT_IMPORT, { numLayouts: fileHandles.length });
  }, [analytics, getCurrentLayoutState, isMounted, layoutManager, onSelectLayout]);

  const exportLayout = useCallbackWithToast(async () => {
    const item = getCurrentLayoutState().selectedLayout?.data;
    if (!item) {
      return;
    }

    const name = getCurrentLayoutState().selectedLayout?.name?.trim() ?? "";
    const layoutName = name.length > 0 ? name : "lichtblick-layout";
    const content = JSON.stringify(item, undefined, 2) ?? "";
    downloadTextFile(content, `${layoutName}.json`);
    void analytics.logEvent(AppEvent.LAYOUT_EXPORT);
  }, [analytics, getCurrentLayoutState]);

  return { importLayout, exportLayout, parseAndInstallLayout };
}
