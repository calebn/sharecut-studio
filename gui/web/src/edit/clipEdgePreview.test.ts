import { describe, expect, it } from "vitest";
import {
  clampTrimSourceSec,
  clipGeometryDuringRoll,
  clipRowDuringRoll,
  MIN_EDGE_SPAN_SEC,
  sourceSecFromTimelineDelta,
} from "./clipEdgePreview";

describe("clipEdgePreview", () => {
  it("clamps out edge to next source start", () => {
    expect(clampTrimSourceSec("out", 20, 0, 5, 0, 15)).toBe(15);
  });

  it("shares one 50 ms edge min span", () => {
    expect(MIN_EDGE_SPAN_SEC).toBe(0.05);
    expect(clampTrimSourceSec("out", 0, 0, 5, 0, 15)).toBe(MIN_EDGE_SPAN_SEC);
  });

  it("clamps in edge to previous source end", () => {
    expect(clampTrimSourceSec("in", 2, 15, 25, 5, 40)).toBe(5);
  });

  it("maps timeline delta onto source", () => {
    expect(sourceSecFromTimelineDelta(5, 2)).toBe(7);
    expect(sourceSecFromTimelineDelta(15, -3)).toBe(12);
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

  it("applies a roll preview to clip rows", () => {
    const left = {
      id: "L",
      source_start: 0,
      source_end: 10,
      timeline_start: 0,
      timeline_end: 10,
    };
    const right = {
      id: "R",
      source_start: 20,
      source_end: 30,
      timeline_start: 10,
      timeline_end: 20,
    };
    const other = {
      id: "O",
      source_start: 30,
      source_end: 35,
      timeline_start: 20,
      timeline_end: 25,
    };
    const preview = { leftClipId: "L", rightClipId: "R", deltaSec: 1.5 };
    expect(clipRowDuringRoll(left, preview)).toEqual({
      ...left,
      source_end: 11.5,
      timeline_end: 11.5,
    });
    expect(clipRowDuringRoll(right, preview)).toEqual({
      ...right,
      source_start: 21.5,
      timeline_start: 11.5,
    });
    expect(clipRowDuringRoll(other, preview)).toBe(other);
    expect(clipRowDuringRoll(left, null)).toBe(left);
  });
});
