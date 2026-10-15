// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { CameraState } from "./camera";

/** Position-follow uses world axes. Keep the painted orbit and move only its center. */
export function robotViewpointCamera(camera: CameraState): CameraState {
  return {
    ...camera,
    target: [0, 0, 0],
    targetOffset: [0, 0, 0],
    targetOrientation: [...camera.targetOrientation],
  };
}
