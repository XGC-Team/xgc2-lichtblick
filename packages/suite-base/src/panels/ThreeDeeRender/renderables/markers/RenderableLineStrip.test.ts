// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { lineStripPointsEqual } from "./RenderableLineStrip";

describe("lineStripPointsEqual", () => {
  it("matches only identical point sequences", () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 2, z: 3 },
    ];
    expect(lineStripPointsEqual(points, points.map((p) => ({ ...p })))).toBe(true);
    expect(lineStripPointsEqual(points, [...points, { x: 4, y: 5, z: 6 }])).toBe(false);
    expect(
      lineStripPointsEqual(points, [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 2, z: 4 },
      ]),
    ).toBe(false);
    expect(lineStripPointsEqual(undefined, [])).toBe(false);
    expect(lineStripPointsEqual([], [])).toBe(true);
  });
});
