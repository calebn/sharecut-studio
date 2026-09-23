import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initTheme,
  isThemePreference,
  PREFERS_LIGHT_QUERY,
  resolvedDocumentTheme,
  type ThemePreference,
} from "./useTheme";

describe("useTheme initTheme", () => {
  const key = "daw_theme";
  const store = new Map<string, string>();
  const dataset: Record<string, string | undefined> = {};

  beforeEach(() => {
    store.clear();
    for (const k of Object.keys(dataset)) {
      delete dataset[k];
    }
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    vi.stubGlobal("document", {
      documentElement: { dataset },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to system with no data-theme", () => {
    const pref = initTheme();
    expect(pref).toBe("system");
    expect(dataset.theme).toBeUndefined();
  });

  it("applies stored dark preference", () => {
    localStorage.setItem(key, "dark");
    expect(initTheme()).toBe("dark" satisfies ThemePreference);
    expect(dataset.theme).toBe("dark");
  });

  it("applies stored light preference", () => {
    localStorage.setItem(key, "light");
    expect(initTheme()).toBe("light");
    expect(dataset.theme).toBe("light");
  });
});

describe("isThemePreference", () => {
  it("accepts the three valid preferences", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isThemePreference("sepia")).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
    expect(isThemePreference(1)).toBe(false);
  });
});

describe("resolvedDocumentTheme", () => {
  const dataset: Record<string, string | undefined> = {};

  function stubPrefersLight(prefersLight: boolean | undefined): void {
    vi.stubGlobal("document", { documentElement: { dataset } });
    if (prefersLight === undefined) {
      vi.stubGlobal("matchMedia", undefined);
      return;
    }
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: prefersLight && q === PREFERS_LIGHT_QUERY,
    }));
  }

  afterEach(() => {
    for (const k of Object.keys(dataset)) {
      delete dataset[k];
    }
    vi.unstubAllGlobals();
  });

  it("prefers an explicit dark data-theme over the OS preference", () => {
    dataset.theme = "dark";
    stubPrefersLight(true);
    expect(resolvedDocumentTheme()).toBe("dark");
  });

  it("prefers an explicit light data-theme over the OS preference", () => {
    dataset.theme = "light";
    stubPrefersLight(false);
    expect(resolvedDocumentTheme()).toBe("light");
  });

  it("falls back to dark when no attribute is set and the OS prefers dark (#209)", () => {
    stubPrefersLight(false);
    expect(resolvedDocumentTheme()).toBe("dark");
  });

  it("falls back to light when no attribute is set and the OS prefers light", () => {
    stubPrefersLight(true);
    expect(resolvedDocumentTheme()).toBe("light");
  });

  it("defaults to the dark baseline when matchMedia is unavailable", () => {
    stubPrefersLight(undefined);
    expect(resolvedDocumentTheme()).toBe("dark");
  });
});
