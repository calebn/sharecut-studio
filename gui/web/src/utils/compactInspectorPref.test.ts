import { afterEach, describe, expect, it } from "vitest";
import {
  COMPACT_INSPECTOR_STORAGE_KEY,
  readCompactInspectorView,
  writeCompactInspectorView,
} from "./compactInspectorPref";

afterEach(() => localStorage.clear());

describe("compact inspector preference", () => {
  it("opens at half height until the user leaves the drawer at full", () => {
    expect(readCompactInspectorView()).toBe("half");
    writeCompactInspectorView("full");
    expect(localStorage.getItem(COMPACT_INSPECTOR_STORAGE_KEY)).toBe("full");
    expect(readCompactInspectorView()).toBe("full");
    writeCompactInspectorView("half");
    expect(readCompactInspectorView()).toBe("half");
  });

  it("reads anything else stored there as half height", () => {
    localStorage.setItem(COMPACT_INSPECTOR_STORAGE_KEY, "inspector");
    expect(readCompactInspectorView()).toBe("half");
  });

  it("reads the peek strip an earlier version stored as half height", () => {
    localStorage.setItem(COMPACT_INSPECTOR_STORAGE_KEY, "peek");
    expect(readCompactInspectorView()).toBe("half");
  });
});
