/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { act, renderHook } from "@testing-library/react";

import { useMemoryValue } from "./useMemoryValue";

it("launch preferences are shared in memory without browser storage", () => {
  const storage = jest.spyOn(Storage.prototype, "setItem");
  const first = renderHook(() => useMemoryValue("launch-test"));
  const second = renderHook(() => useMemoryValue("launch-test"));
  act(() => {
    first.result.current[1]("web");
  });
  expect(second.result.current[0]).toBe("web");
  expect(storage).not.toHaveBeenCalled();
  act(() => {
    first.result.current[1](undefined);
  });
  expect(second.result.current[0]).toBeUndefined();
  expect(() => {
    first.result.current[1]("x".repeat(513));
  }).toThrow("limit exceeded");
});
