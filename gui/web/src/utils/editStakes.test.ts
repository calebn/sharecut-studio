import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissEditStakes,
  EDIT_STAKES_TEXT,
  editStakesSeen,
  editStakesUp,
  markEditStakesSeen,
  raiseEditStakes,
  resetEditStakesForTests,
  subscribeEditStakes,
} from "./editStakes";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem("sharecut.editStakesSeen.alpha");
  localStorage.removeItem("sharecut.editStakesSeen.beta");
  resetEditStakesForTests();
});

describe("the edit reminder's memory", () => {
  it("says what changed and what Undo takes back", () => {
    expect(EDIT_STAKES_TEXT).toBe(
      "You changed the host's episode, and everyone sees it. Undo takes back only your own step.",
    );
  });

  it("is unseen by default and seen under that link's key once marked", () => {
    expect(editStakesSeen("alpha")).toBe(false);
    markEditStakesSeen("alpha");
    expect(editStakesSeen("alpha")).toBe(true);
    expect(localStorage.getItem("sharecut.editStakesSeen.alpha")).toBe("1");
  });

  it("keeps each link independent", () => {
    markEditStakesSeen("alpha");
    expect(editStakesSeen("beta")).toBe(false);
  });

  it("reads a page with no link as seen and writes nothing", () => {
    expect(editStakesSeen(null)).toBe(true);
    markEditStakesSeen(null);
    expect(localStorage.length).toBe(0);
  });

  it("does not repeat in the session where storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(() => markEditStakesSeen("alpha")).not.toThrow();
    expect(editStakesSeen("alpha")).toBe(true);
  });
});

describe("the edit reminder's raise", () => {
  it("is up after a raise, once, and down after a dismissal", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEditStakes(listener);
    raiseEditStakes("alpha");
    raiseEditStakes("alpha");
    expect(editStakesUp()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    dismissEditStakes();
    expect(editStakesUp()).toBe(false);
    unsubscribe();
  });

  it("does not rise for a link that has seen it, or for no link", () => {
    markEditStakesSeen("alpha");
    raiseEditStakes("alpha");
    raiseEditStakes(null);
    expect(editStakesUp()).toBe(false);
  });
});
