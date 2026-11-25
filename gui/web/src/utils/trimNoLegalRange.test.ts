import { describe, expect, it } from "vitest";
import { nudgeAxis, nudgeStep } from "../edit/nudge";
import {
  noRangeLane,
  noRangeProject,
  skipProject,
} from "../test/timedTrimLane";
import { patchClipTrim } from "./ripplePreview";
import { hasTrimRange, trimEdgeLimits } from "./trimLimits";

describe("a timing correction can leave a trim edge no legal range", () => {
  it("returns the server's inverted pair as it is", () => {
    const { lo, hi } = trimEdgeLimits(noRangeLane(), 0, "out", "ripple");
    expect(lo).toBeCloseTo(15.500001, 9);
    expect(hi).toBe(15.2);
    expect(hasTrimRange({ lo, hi })).toBe(false);
  });

  it("treats the same lane without the correction as an ordinary range", () => {
    const limits = trimEdgeLimits(noRangeLane(false), 0, "out", "ripple");
    expect(limits).toEqual({ lo: 10.05, hi: 15.2 });
    expect(hasTrimRange(limits)).toBe(true);
  });

  it("refuses exactly where the server does: lo > hi, with no tolerance", () => {
    expect(hasTrimRange({ lo: 5, hi: 5 })).toBe(true);
    expect(hasTrimRange({ lo: 5 + 1e-10, hi: 5 })).toBe(false);
    expect(hasTrimRange({ lo: 5.001, hi: 5 })).toBe(false);
  });

  it("does not move a nudged edge", () => {
    const field = {
      kind: "trim",
      trackId: "host",
      clipId: "a",
      edge: "out",
    } as const;
    const axis = nudgeAxis(noRangeProject(), field)!;
    for (const delta of [-0.5, 0.1, 3]) {
      expect(nudgeStep(axis, [], 20, delta, false)).toEqual({
        value: 20,
        stop: { kind: "limit" },
      });
    }
    // The untimed lane still nudges.
    const open = nudgeAxis(noRangeProject(false), field)!;
    expect(nudgeStep(open, [], 14, 0.1, false).value).toBeCloseTo(14.1, 9);
  });

  it("stops a nudged contraction at the correction too", () => {
    const axis = nudgeAxis(skipProject(), {
      kind: "trim",
      trackId: "host",
      clipId: "a",
      edge: "out",
    })!;
    expect(nudgeStep(axis, [], 20, -9, false).value).toBeCloseTo(15.500001, 9);
  });

  it("previews no trim, so a save that would be refused shows nothing", () => {
    const project = noRangeProject();
    expect(patchClipTrim(project, "a", "out", 15.3, "ripple")).toBe(project);
    expect(patchClipTrim(project, "a", "out", 18, "ripple")).toBe(project);
    const open = noRangeProject(false);
    expect(patchClipTrim(open, "a", "out", 15, "ripple")).not.toBe(open);
  });
});
