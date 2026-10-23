import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAWER_COLLAPSED_STORAGE_KEY,
  readDrawerCollapsed,
  writeDrawerCollapsed,
} from "./drawerCollapsedPref";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(DRAWER_COLLAPSED_STORAGE_KEY);
  vi.resetModules();
});

describe("drawer collapsed preference", () => {
  it("round-trips and clears", () => {
    expect(readDrawerCollapsed()).toBe(false);
    writeDrawerCollapsed(true);
    expect(localStorage.getItem(DRAWER_COLLAPSED_STORAGE_KEY)).toBe("1");
    expect(readDrawerCollapsed()).toBe(true);
    writeDrawerCollapsed(false);
    expect(localStorage.getItem(DRAWER_COLLAPSED_STORAGE_KEY)).toBeNull();
    expect(readDrawerCollapsed()).toBe(false);
  });

  it("ignores any other stored value", () => {
    localStorage.setItem(DRAWER_COLLAPSED_STORAGE_KEY, "true");
    expect(readDrawerCollapsed()).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readDrawerCollapsed()).toBe(false);
    expect(() => writeDrawerCollapsed(true)).not.toThrow();
    expect(() => writeDrawerCollapsed(false)).not.toThrow();
  });

  it("starts without a saved choice in adaptive layout without saving a collapse", async () => {
    vi.resetModules();
    const { useDawStore } = await import("../state/dawStore");
    expect(useDawStore.getState().layoutMode).toBe("adaptive");
    expect(localStorage.getItem(DRAWER_COLLAPSED_STORAGE_KEY)).toBeNull();
  });

  it("opens a new session in the timeline layout when it was left collapsed", async () => {
    localStorage.setItem(DRAWER_COLLAPSED_STORAGE_KEY, "1");
    vi.resetModules();
    const { useDawStore } = await import("../state/dawStore");
    expect(useDawStore.getState().layoutMode).toBe("timeline");
  });
});
