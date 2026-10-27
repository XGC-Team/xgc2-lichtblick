// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** @jest-environment node */

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { createElement } from "react";
import { renderToString } from "react-dom/server";

import useVisibilityState from "./useVisibilityState";

it("renders a visible server snapshot without a browser document", () => {
  function Surface(): React.JSX.Element {
    return createElement("span", undefined, useVisibilityState());
  }
  expect(typeof document).toBe("undefined");
  expect(renderToString(createElement(Surface))).toBe("<span>visible</span>");
});
