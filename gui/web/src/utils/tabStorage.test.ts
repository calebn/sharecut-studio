import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockStorage } from "../test/blockStorage";
import { getTab, removeTab, setTab } from "./tabStorage";

describe("tabStorage", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips values in sessionStorage", () => {
    expect(getTab("k")).toBeNull();
    expect(setTab("k", "v")).toBe(true);
    expect(sessionStorage.getItem("k")).toBe("v");
    expect(getTab("k")).toBe("v");
  });

  it("keeps an empty stored value distinct from a missing one", () => {
    sessionStorage.setItem("k", "");
    expect(getTab("k")).toBe("");
  });

  it("never throws when storage access is blocked", () => {
    blockStorage();
    expect(getTab("k")).toBeNull();
    expect(setTab("k", "v")).toBe(false);
  });

  it("reports a quota failure as an unsaved write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(setTab("k", "v")).toBe(false);
  });

  it("degrades when the global is missing", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(getTab("k")).toBeNull();
    expect(setTab("k", "v")).toBe(false);
  });

  describe("removeTab", () => {
    it("removes a stored value", () => {
      setTab("k", "v");
      removeTab("k");
      expect(getTab("k")).toBeNull();
    });

    it("never throws when removal is blocked", () => {
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
      expect(() => removeTab("k")).not.toThrow();
    });

    it("degrades when the global is missing", () => {
      vi.stubGlobal("sessionStorage", undefined);
      expect(() => removeTab("k")).not.toThrow();
    });
  });
});
