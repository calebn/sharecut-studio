import { describe, expect, it } from "vitest";
import { DRAG_DETENT_PX } from "../hooks/gestureConstants";
import { detentMove, startDetents } from "./dragDetent";

// 100 px/s from 2 s at x 200: x 250 is 2.5 s, x 262 is 2.62 s.
const track = () =>
  startDetents(2, 200, 100, [
    { sec: 2.5, label: "the playhead" },
    { sec: 2.62, label: "the pending remove" },
  ]);

describe("detentMove", () => {
  it("holds at a boundary within the detent, and lets go past it", () => {
    const t = track();
    expect(detentMove(t, 240)).toEqual({
      x: 240,
      caught: null,
      released: false,
    });
    expect(detentMove(t, 255).x).toBe(250);
    expect(detentMove(t, 250 + DRAG_DETENT_PX).x).toBe(250);
    expect(detentMove(t, 230)).toEqual({
      x: 230,
      caught: null,
      released: true,
    });
  });

  it("catches the next boundary a push off one carries it past", () => {
    const t = track();
    expect(detentMove(t, 255).caught?.label).toBe("the playhead");
    const step = detentMove(t, 250 + DRAG_DETENT_PX + 2);
    expect(step).toEqual({
      x: 262,
      caught: { sec: 2.62, label: "the pending remove" },
      released: true,
    });
  });
});
