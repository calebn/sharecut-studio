import { describe, expect, it } from "vitest";
import { clipRow } from "../test/fixtures";
import { rippledStarts, rippleOf } from "./ripplePreview";

const a = clipRow({
  id: "a",
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
  timeline_end: 10,
});
const b = clipRow({
  id: "b",
  source_start: 10,
  source_end: 20,
  timeline_start: 10,
  timeline_end: 20,
});
const c = clipRow({
  id: "c",
  source_start: 30,
  source_end: 35,
  timeline_start: 25,
  timeline_end: 30,
});

describe("ripple preview (#1135)", () => {
  it("moves every later clip on the lane by the trimmed clip's change in length", () => {
    const ripple = rippleOf(a, { sourceStart: 2, sourceEnd: 10 });
    expect(ripple).toEqual({ clipId: "a", afterSec: 10, deltaSec: -2 });
    expect(rippledStarts([a, b, c], ripple)).toEqual({ b: 8, c: 23 });
  });

  it("moves nothing for a trim back to where it started", () => {
    const ripple = rippleOf(b, { sourceStart: 10, sourceEnd: 20 });
    expect(ripple).toBeNull();
    expect(rippledStarts([a, b, c], ripple)).toEqual({});
  });

  it("leaves earlier clips where they are", () => {
    expect(
      rippledStarts([a, b, c], rippleOf(b, { sourceStart: 10, sourceEnd: 21 })),
    ).toEqual({ c: 26 });
  });
});
