import { describe, expect, it } from "vitest";
import {
  clampRollDelta,
  clampTrimSourceSec,
  clipGeometryDuringRoll,
  sourceSecFromTimelineDelta,
} from "./clipEdgePreview";

describe("clipEdgePreview", () => {
  it("clamps out edge to next source start", () => {
    expect(clampTrimSourceSec("out", 20, 0, 5, 0, 15)).toBe(15);
  });

  it("clamps in edge to previous source end", () => {
    expect(clampTrimSourceSec("in", 2, 15, 25, 5, 40)).toBe(5);
  });

  it("maps timeline delta onto source", () => {
    expect(sourceSecFromTimelineDelta("out", 5, 2)).toBe(7);
    expect(sourceSecFromTimelineDelta("in", 15, -3)).toBe(12);
  });

  it("clamps roll delta to min spans and neighbors", () => {
    const bounds = {
      leftSourceStart: 0,
      leftSourceEnd: 5,
      rightSourceStart: 15,
      rightSourceEnd: 25,
      prevSourceEnd: 0,
      nextSourceStart: 30,
      mediaEnd: 80,
    };
    expect(clampRollDelta(2, bounds)).toBe(2);
    expect(clampRollDelta(100, bounds)).toBe(9.95); // right min span
    expect(clampRollDelta(-100, bounds)).toBe(-4.95); // left min span
  });

  it("limits roll-later by a short right clip (~2s)", () => {
    const bounds = {
      leftSourceStart: 0,
      leftSourceEnd: 10,
      rightSourceStart: 10,
      rightSourceEnd: 12,
      prevSourceEnd: 0,
      nextSourceStart: Number.POSITIVE_INFINITY,
      mediaEnd: 80,
    };
    expect(clampRollDelta(100, bounds)).toBeCloseTo(1.95);
  });

  it("limits roll-earlier by a short left clip (~2s)", () => {
    const bounds = {
      leftSourceStart: 8,
      leftSourceEnd: 10,
      rightSourceStart: 10,
      rightSourceEnd: 30,
      prevSourceEnd: 0,
      nextSourceStart: Number.POSITIVE_INFINITY,
      mediaEnd: 80,
    };
    expect(clampRollDelta(-100, bounds)).toBeCloseTo(-1.95);
  });

  it("keeps trim edges inside the clip span", () => {
    // out: cannot shrink below min span or past neighbor
    expect(clampTrimSourceSec("out", 0, 10, 12, 0, 40)).toBe(10.05);
    expect(clampTrimSourceSec("out", 100, 10, 12, 0, 15)).toBe(15);
    // in: cannot grow past end-minSpan or before neighbor
    expect(clampTrimSourceSec("in", 100, 10, 12, 0, 40)).toBe(11.95);
    expect(clampTrimSourceSec("in", 0, 10, 12, 5, 40)).toBe(5);
  });

  it("keeps both roll sides flush during preview", () => {
    const left = {
      id: "L",
      source_start: 0,
      source_end: 10,
      timeline_start: 0,
    };
    const right = {
      id: "R",
      source_start: 20,
      source_end: 30,
      timeline_start: 10,
    };
    const preview = { leftClipId: "L", rightClipId: "R", deltaSec: 1.5 };
    const lg = clipGeometryDuringRoll(left, preview);
    const rg = clipGeometryDuringRoll(right, preview);
    expect(lg.sourceEnd).toBe(11.5);
    expect(rg.sourceStart).toBe(21.5);
    expect(rg.timelineStart).toBe(11.5);
    // Left timeline_end preview == right timeline_start preview
    expect(lg.timelineStart + (lg.sourceEnd - lg.sourceStart)).toBe(
      rg.timelineStart,
    );
  });
});
