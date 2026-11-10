import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetThemeForTests,
  initTheme,
  THEME_STORAGE_KEY,
  useTheme,
} from "./useTheme";

describe("useTheme shared store", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    __resetThemeForTests();
  });

  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    __resetThemeForTests();
  });

  it("updates every instance when one sets the preference", () => {
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());
    expect(b.result.current.preference).toBe("system");
    act(() => a.result.current.setPreference("dark"));
    expect(a.result.current.preference).toBe("dark");
    expect(b.result.current.preference).toBe("dark");
  });

  it("writes daw_theme and applies data-theme on set", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setPreference("light"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => result.current.setPreference("system"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("reads the stored preference lazily", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("dark");
  });

  it("does not write storage just by mounting", () => {
    renderHook(() => useTheme());
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("initTheme seeds the snapshot", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    act(() => {
      initTheme();
    });
    expect(result.current.preference).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
