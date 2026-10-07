import { afterEach, describe, expect, it } from "vitest";
import {
  COMPACT_INSPECTOR_STORAGE_KEY,
  readCompactInspectorView,
  writeCompactInspectorView,
} from "./compactInspectorPref";

afterEach(() => localStorage.clear());

describe("compact inspector preference", () => {
  it("opens at the peek strip until the user leaves the drawer at another detent", () => {
    expect(readCompactInspectorView()).toBe("peek");
    writeCompactInspectorView("full");
    expect(localStorage.getItem(COMPACT_INSPECTOR_STORAGE_KEY)).toBe("full");
    expect(readCompactInspectorView()).toBe("full");
    writeCompactInspectorView("half");
    expect(readCompactInspectorView()).toBe("half");
  });

  it("reads anything else stored there as the peek strip", () => {
    localStorage.setItem(COMPACT_INSPECTOR_STORAGE_KEY, "inspector");
    expect(readCompactInspectorView()).toBe("peek");
  });
});
