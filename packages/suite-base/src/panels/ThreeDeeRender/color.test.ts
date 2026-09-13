// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { textLabelBackground } from "./color";

describe("textLabelBackground", () => {
  it("uses an explicit plate color and the foreground alpha", () => {
    expect(
      textLabelBackground({ r: 1, g: 0.75, b: 0, a: 0.4 }, { backgroundColor: "#112233" }),
    ).toEqual({ r: 17 / 255, g: 34 / 255, b: 51 / 255, a: 0.4 });
  });

  it("picks a black plate for light amber text", () => {
    expect(textLabelBackground({ r: 1, g: 191 / 255, b: 0, a: 1 })).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    });
  });

  it("picks a white plate for dark text", () => {
    expect(textLabelBackground({ r: 0.1, g: 0.1, b: 0.2, a: 0.8 })).toEqual({
      r: 1,
      g: 1,
      b: 1,
      a: 0.8,
    });
  });

  it("draws a fully transparent plate when the background is turned off", () => {
    expect(
      textLabelBackground(
        { r: 1, g: 191 / 255, b: 0, a: 0.7 },
        { backgroundColor: "#112233", showBackground: false },
      ),
    ).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});
