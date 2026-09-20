import { afterEach, describe, expect, it } from "vitest";
import { migrateLocalStorageKey } from "./legacyStorage";

describe("migrateLocalStorageKey", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns the current key when already set", () => {
    window.localStorage.setItem("new", "now");
    window.localStorage.setItem("old", "was");
    expect(migrateLocalStorageKey("new", "old")).toBe("now");
    expect(window.localStorage.getItem("old")).toBe("was");
  });

  it("copies the legacy key once", () => {
    window.localStorage.setItem("old", "was");
    expect(migrateLocalStorageKey("new", "old")).toBe("was");
    expect(window.localStorage.getItem("new")).toBe("was");
    expect(window.localStorage.getItem("old")).toBeNull();
  });

  it("returns null when neither key exists", () => {
    expect(migrateLocalStorageKey("new", "old")).toBeNull();
  });
});
