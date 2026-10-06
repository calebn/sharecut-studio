import { afterEach, describe, expect, it } from "vitest";
import {
  COMPACT_INSPECTOR_STORAGE_KEY,
  readCompactInspectorView,
  writeCompactInspectorView,
} from "./compactInspectorPref";

afterEach(() => localStorage.clear());

describe("compact inspector preference", () => {
  it("opens as the strip until the user expands it, then as the inspector", () => {
    expect(readCompactInspectorView()).toBe("strip");
    writeCompactInspectorView("inspector");
    expect(localStorage.getItem(COMPACT_INSPECTOR_STORAGE_KEY)).toBe(
      "inspector",
    );
    expect(readCompactInspectorView()).toBe("inspector");
    writeCompactInspectorView("strip");
    expect(readCompactInspectorView()).toBe("strip");
  });

  it("reads anything else stored there as the strip", () => {
    localStorage.setItem(COMPACT_INSPECTOR_STORAGE_KEY, "full");
    expect(readCompactInspectorView()).toBe("strip");
  });
});
