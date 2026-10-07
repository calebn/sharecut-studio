import { afterEach, describe, expect, it, vi } from "vitest";
import { offersHomeScreenHint, readHomeScreenEnv } from "./homeScreenHint";

const IPHONE_TAB = {
  standalone: false,
  maxTouchPoints: 5,
  displayModeBrowser: true,
};

describe("offersHomeScreenHint", () => {
  it("offers the hint in an iPhone or iPad Safari tab", () => {
    expect(offersHomeScreenHint(IPHONE_TAB)).toBe(true);
  });

  it.each([
    ["from the Home Screen", { ...IPHONE_TAB, standalone: true }],
    [
      "as an installed app",
      { ...IPHONE_TAB, standalone: true, displayModeBrowser: false },
    ],
    ["outside iOS", { ...IPHONE_TAB, standalone: undefined }],
    ["in desktop Safari", { ...IPHONE_TAB, maxTouchPoints: 0 }],
  ])("stays quiet %s", (_case, env) => {
    expect(offersHomeScreenHint(env)).toBe(false);
  });
});

describe("readHomeScreenEnv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads iOS standalone, touch points and the display mode", () => {
    vi.stubGlobal("navigator", { standalone: false, maxTouchPoints: 5 });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(display-mode: browser)",
    }));
    expect(readHomeScreenEnv()).toEqual(IPHONE_TAB);
  });
});
