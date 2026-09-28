import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import {
  clampRollDelta,
  clampTrimSourceSec,
  clipGeometryDuringRoll,
  MIN_EDGE_SPAN_SEC,
  rollNeighborBounds,
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

describe("rollNeighborBounds", () => {
  it("returns infinite bounds when the project is null", () => {
    const leftClip = clipRow({ id: "left" });
    const rightClip = clipRow({ id: "right" });
    expect(rollNeighborBounds(null, leftClip, rightClip)).toEqual({
      prevSourceEnd: 0,
      nextSourceStart: Number.POSITIVE_INFINITY,
      mediaEnd: Number.POSITIVE_INFINITY,
    });
  });

  it("finds the source_end before the left clip and source_start after the right clip in an unsorted track", () => {
    const before = clipRow({
      id: "before",
      track_id: "host",
      source_start: 0,
      source_end: 4,
      timeline_start: 0,
      timeline_end: 4,
    });
    const left = clipRow({
      id: "left",
      track_id: "host",
      source_start: 5,
      source_end: 9,
      timeline_start: 4,
      timeline_end: 8,
    });
    const right = clipRow({
      id: "right",
      track_id: "host",
      source_start: 10,
      source_end: 14,
      timeline_start: 8,
      timeline_end: 12,
    });
    const after = clipRow({
      id: "after",
      track_id: "host",
      source_start: 15,
      source_end: 20,
      timeline_start: 12,
      timeline_end: 17,
    });
    const project = minimalProject({
      clips: {
        tracks: { host: [right, after, before, left] },
        clip_count: 4,
      },
      tracks: [sampleTrack({ id: "host", duration_sec: 60 })],
    });
    expect(rollNeighborBounds(project, left, right)).toEqual({
      prevSourceEnd: 4,
      nextSourceStart: 15,
      mediaEnd: 60,
    });
  });

  it("falls back to the track duration when there is no clip after the right clip", () => {
    const left = clipRow({
      id: "left",
      track_id: "host",
      source_start: 5,
      source_end: 9,
      timeline_start: 0,
      timeline_end: 4,
    });
    const right = clipRow({
      id: "right",
      track_id: "host",
      source_start: 10,
      source_end: 14,
      timeline_start: 4,
      timeline_end: 8,
    });
    const project = minimalProject({
      clips: { tracks: { host: [left, right] }, clip_count: 2 },
      tracks: [sampleTrack({ id: "host", duration_sec: 80 })],
    });
    expect(rollNeighborBounds(project, left, right)).toEqual({
      prevSourceEnd: 0,
      nextSourceStart: 80,
      mediaEnd: 80,
    });
  });
});
