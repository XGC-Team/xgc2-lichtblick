// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";

import { LayoutData } from "@lichtblick/suite-base/context/CurrentLayoutContext/actions";

/** Compare the JSON document, including new camera/panel fields and omitting unset preferences. */
export function isLayoutEqual(baseline: LayoutData, current: LayoutData): boolean {
  return _.isEqual(JSON.parse(JSON.stringify(baseline)!), JSON.parse(JSON.stringify(current)!));
}
