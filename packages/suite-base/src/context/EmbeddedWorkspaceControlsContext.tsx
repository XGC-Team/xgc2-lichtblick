// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export const EMBEDDED_PANEL_CONTROLS_ATTRIBUTE = "data-xgc2-panel-controls";

type EmbeddedWorkspaceControls = {
  hidePanelControls: () => void;
  panelControlsVisible: boolean;
  togglePanelControls: () => void;
};

const defaultValue: EmbeddedWorkspaceControls = {
  hidePanelControls: () => {},
  panelControlsVisible: false,
  togglePanelControls: () => {},
};

export const EmbeddedWorkspaceControlsContext =
  createContext<EmbeddedWorkspaceControls>(defaultValue);
EmbeddedWorkspaceControlsContext.displayName = "EmbeddedWorkspaceControlsContext";

export function useEmbeddedWorkspaceControls(): EmbeddedWorkspaceControls {
  return useContext(EmbeddedWorkspaceControlsContext);
}

export function EmbeddedWorkspaceControlsProvider({
  children,
}: PropsWithChildren): React.JSX.Element {
  const [panelControlsVisible, setPanelControlsVisible] = useState(false);
  const hidePanelControls = useCallback(() => {
    setPanelControlsVisible(false);
  }, []);
  const togglePanelControls = useCallback(() => {
    setPanelControlsVisible((visible) => !visible);
  }, []);

  useEffect(() => {
    if (!panelControlsVisible) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(`[${EMBEDDED_PANEL_CONTROLS_ATTRIBUTE}]`) != null
      ) {
        return;
      }
      hidePanelControls();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hidePanelControls();
      }
    };

    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [hidePanelControls, panelControlsVisible]);

  const value = useMemo(
    () => ({ hidePanelControls, panelControlsVisible, togglePanelControls }),
    [hidePanelControls, panelControlsVisible, togglePanelControls],
  );

  return (
    <EmbeddedWorkspaceControlsContext.Provider value={value}>
      {children}
    </EmbeddedWorkspaceControlsContext.Provider>
  );
}
