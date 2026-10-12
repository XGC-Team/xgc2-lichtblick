// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect, useLayoutEffect, useState } from "react";
import { useMedia } from "react-use";

import { AppSetting } from "@lichtblick/suite-base/AppSetting";
import { useAppConfigurationValue } from "@lichtblick/suite-base/hooks";
import ThemeProvider from "@lichtblick/suite-base/theme/ThemeProvider";

import { embeddedParentOrigin, isEmbeddedThemeCommand } from "./EmbeddedWorkspaceProtocol";

export function ColorSchemeThemeProvider({
  children,
  embedded = false,
}: React.PropsWithChildren<{ embedded?: boolean }>): React.JSX.Element {
  const [colorScheme = "system"] = useAppConfigurationValue<string>(AppSetting.COLOR_SCHEME);
  const systemSetting = useMedia("(prefers-color-scheme: dark)");
  const [hostScheme, setHostScheme] = useState<"dark" | "light" | undefined>();
  const userDark = colorScheme === "dark" || (colorScheme === "system" && systemSetting);
  const isDark = embedded ? hostScheme === "dark" : userDark;

  useEffect(() => {
    if (!embedded) {
      return;
    }
    const parentWindow = window.parent;
    const expectedOrigin = embeddedParentOrigin();
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== expectedOrigin || event.source !== parentWindow) {
        return;
      }
      if (!isEmbeddedThemeCommand(event.data)) {
        return;
      }
      setHostScheme(event.data.colorScheme);
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [embedded]);

  useLayoutEffect(() => {
    if (!embedded) {
      return;
    }
    const root = document.getElementById("root");
    const page = document.documentElement;
    const body = document.body;
    if (hostScheme == undefined) {
      page.setAttribute("data-xgc2-embed", "pending");
      page.style.backgroundColor = "transparent";
      body.style.backgroundColor = "transparent";
      if (root) {
        root.style.visibility = "hidden";
      }
      return;
    }
    page.removeAttribute("data-xgc2-embed");
    page.style.backgroundColor = "";
    body.style.backgroundColor = "";
    if (root) {
      root.style.visibility = "";
    }
  }, [embedded, hostScheme]);

  return <ThemeProvider isDark={isDark}>{children}</ThemeProvider>;
}
