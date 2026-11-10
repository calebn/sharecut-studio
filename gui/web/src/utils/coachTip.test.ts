import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCoachTipsForTests,
  COACH_TIPS,
  coachTipOwner,
  coachTipSeen,
  dismissCoachTip,
  markCoachTipSeen,
  releaseCoachTip,
  showCoachTip,
  undoTipMoment,
} from "./coachTip";

beforeEach(() => {
  localStorage.clear();
  _resetCoachTipsForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("coach tips", () => {
  it("holds the four lines the spec names", () => {
    expect(COACH_TIPS).toEqual({
      trim: "Drag the edges to trim",
      selectionHandles: "Drag the handles to adjust",
      undo: "Two-finger tap to undo",
      rangeToggle: "Drag across a lane to select",
    });
  });

  it("remembers a tip in this browser under its own key", () => {
    markCoachTipSeen("trim");
    expect(localStorage.getItem("sharecut.coachTipSeen.trim")).toBe("1");
    expect(coachTipSeen("trim")).toBe(true);
    expect(coachTipSeen("undo")).toBe(false);
  });

  it("does not repeat in the same session when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    markCoachTipSeen("trim");
    expect(coachTipSeen("trim")).toBe(true);
    expect(showCoachTip("trim", Symbol("a"))).toBe(false);
  });

  it("holds one tip at a time, for the owner that raised it", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    expect(showCoachTip("trim", a)).toBe(true);
    expect(showCoachTip("undo", b)).toBe(false);
    releaseCoachTip(b);
    expect(coachTipOwner()).toBe(a);
    releaseCoachTip(a);
    expect(coachTipOwner()).toBeNull();
    expect(coachTipSeen("trim")).toBe(false);
    expect(showCoachTip("trim", a)).toBe(true);
    dismissCoachTip("trim");
    expect(coachTipOwner()).toBeNull();
    expect(coachTipSeen("trim")).toBe(true);
  });

  it("names the toast that offers history Undo, and no gesture toast", () => {
    const toast = (undo: string | null, gesture: boolean) => ({
      id: 3,
      undo,
      gesture,
    });
    expect(undoTipMoment(toast("h", false))).toBe(3);
    expect(undoTipMoment(toast(null, false))).toBeNull();
    expect(undoTipMoment(toast("h", true))).toBeNull();
    expect(undoTipMoment(null)).toBeNull();
  });
});
