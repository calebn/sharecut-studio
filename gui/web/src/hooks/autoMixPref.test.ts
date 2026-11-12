import { afterEach, describe, expect, it, vi } from "vitest";
import { blockStorage } from "../test/blockStorage";
import { AUTO_MIX_PREF_KEY, autoMixPaused } from "./autoMixPref";

describe("autoMixPaused", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("is true only when the preference is off", () => {
    expect(autoMixPaused()).toBe(false);
    localStorage.setItem(AUTO_MIX_PREF_KEY, "off");
    expect(autoMixPaused()).toBe(true);
  });

  it("ignores sessionStorage", () => {
    sessionStorage.setItem(AUTO_MIX_PREF_KEY, "off");
    expect(autoMixPaused()).toBe(false);
    sessionStorage.clear();
  });

  it("is false when storage is blocked", () => {
    localStorage.setItem(AUTO_MIX_PREF_KEY, "off");
    blockStorage();
    expect(autoMixPaused()).toBe(false);
  });
});
