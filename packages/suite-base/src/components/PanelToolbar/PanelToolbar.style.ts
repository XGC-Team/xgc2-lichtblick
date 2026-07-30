// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { alpha } from "@mui/material";
import { makeStyles } from "tss-react/mui";

import { PANEL_TOOLBAR_MIN_HEIGHT } from "@lichtblick/suite-base/components/PanelToolbar/constants";

export const useStyles = makeStyles()((theme) => ({
  root: {
    transition: "transform 80ms ease-in-out, opacity 80ms ease-in-out",
    cursor: "auto",
    flex: "0 0 auto",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: theme.spacing(0.25, 0.75),
    display: "flex",
    minHeight: PANEL_TOOLBAR_MIN_HEIGHT,
    backgroundColor: theme.palette.background.paper,
    width: "100%",
    left: 0,
    zIndex: theme.zIndex.appBar,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    position: "relative !important" as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    top: "auto !important" as any,
  },
  embedded: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    position: "absolute !important" as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    top: `${theme.spacing(0.75)} !important` as any,
    right: theme.spacing(0.75),
    left: "auto",
    zIndex: theme.zIndex.appBar,
    width: "max-content",
    maxWidth: `calc(100% - ${theme.spacing(1.5)})`,
    minHeight: 0,
    padding: theme.spacing(0.25),
    border: `1px solid ${alpha(theme.palette.divider, 0.72)}`,
    borderRadius: theme.shape.borderRadius,
    backgroundColor: alpha(theme.palette.background.paper, 0.88),
    boxShadow: theme.shadows[3],
    backdropFilter: "blur(6px)",
    transition: "transform 120ms ease-in-out, opacity 120ms ease-in-out",
    visibility: "hidden",
    opacity: 0,
    pointerEvents: "none",
    transform: `translateY(-${theme.spacing(0.5)})`,
  },
  embeddedVisible: {
    visibility: "visible",
    opacity: 1,
    pointerEvents: "auto",
    transform: "translateY(0)",
  },
  embeddedWithChildren: {
    left: theme.spacing(0.75),
    width: "auto",
    maxWidth: "none",
    minWidth: 0,
  },
}));
