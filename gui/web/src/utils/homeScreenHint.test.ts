import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetHomeVisitCountForTests,
  countHomeVisit,
  dismissHomeScreenHint,
  HOME_SCREEN_HINT_DISMISSED_KEY,
  HOME_VISITS_KEY,
  homeScreenHintDismissed,
  homeScreenHintDue,
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

describe("the card's dismissal", () => {
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

describe("the visit counter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem(HOME_VISITS_KEY);
    localStorage.removeItem(HOME_SCREEN_HINT_DISMISSED_KEY);
    _resetHomeVisitCountForTests();
  });

  it("returns the visits before this one and counts it once per page load", () => {
    expect(countHomeVisit()).toBe(0);
    expect(countHomeVisit()).toBe(0);
    expect(localStorage.getItem(HOME_VISITS_KEY)).toBe("1");
    _resetHomeVisitCountForTests();
    expect(countHomeVisit()).toBe(1);
    expect(localStorage.getItem(HOME_VISITS_KEY)).toBe("2");
  });

  it("reads a damaged count as no visits", () => {
    localStorage.setItem(HOME_VISITS_KEY, "many");
    expect(countHomeVisit()).toBe(0);
  });

  it("offers the card from the second visit, in a Safari tab, until dismissed", () => {
    expect(homeScreenHintDue(IPHONE_TAB, 0)).toBe(false);
    expect(homeScreenHintDue(IPHONE_TAB, 1)).toBe(true);
    expect(homeScreenHintDue({ ...IPHONE_TAB, standalone: true }, 5)).toBe(
      false,
    );
    dismissHomeScreenHint();
    expect(homeScreenHintDue(IPHONE_TAB, 5)).toBe(false);
  });

  it("never offers the card where storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(homeScreenHintDue(IPHONE_TAB, countHomeVisit())).toBe(false);
  });
});
