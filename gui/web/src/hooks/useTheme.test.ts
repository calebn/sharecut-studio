import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme, type ThemePreference } from "./useTheme";

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
