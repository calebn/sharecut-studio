import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissHomeScreenHint,
  HOME_SCREEN_HINT_DISMISSED_KEY,
  homeScreenHintDismissed,
  offersHomeScreenHint,
  readHomeScreenEnv,
} from "./homeScreenHint";

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

describe("the banner's dismissal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(HOME_SCREEN_HINT_DISMISSED_KEY);
  });

  it("is remembered in this browser once dismissed", () => {
    expect(homeScreenHintDismissed()).toBe(false);
    dismissHomeScreenHint();
    expect(localStorage.getItem("sharecut.homeScreenHintDismissed")).toBe("1");
    expect(homeScreenHintDismissed()).toBe(true);
  });

  it("is forgotten, not thrown, where storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(() => dismissHomeScreenHint()).not.toThrow();
    expect(homeScreenHintDismissed()).toBe(false);
  });
});
