import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPaletteRecent, rememberPaletteRecent } from "./paletteRecent";

describe("palette recents", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps the newest first without repeats and caps the list", () => {
    rememberPaletteRecent("a");
    rememberPaletteRecent("b");
    expect(rememberPaletteRecent("a")).toEqual(["a", "b"]);
    for (let i = 0; i < 30; i++) rememberPaletteRecent(`c${i}`);
    expect(readPaletteRecent()).toHaveLength(12);
    expect(readPaletteRecent()[0]).toBe("c29");
  });

  it("reads corrupt or non-array storage as empty", () => {
    localStorage.setItem("sharecut.palette.recent.v1", "{oops");
    expect(readPaletteRecent()).toEqual([]);
    localStorage.setItem("sharecut.palette.recent.v1", '{"a":1}');
    expect(readPaletteRecent()).toEqual([]);
    localStorage.setItem("sharecut.palette.recent.v1", '["a",3,"b"]');
    expect(readPaletteRecent()).toEqual(["a", "b"]);
  });

  it("reads repeated ids once", () => {
    localStorage.setItem("sharecut.palette.recent.v1", '["a","b","a","b","c"]');
    expect(readPaletteRecent()).toEqual(["a", "b", "c"]);
  });

  it("does not throw when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readPaletteRecent()).toEqual([]);
    expect(rememberPaletteRecent("a")).toEqual(["a"]);
  });
});
