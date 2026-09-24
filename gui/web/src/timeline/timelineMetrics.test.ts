import { describe, expect, it } from "vitest";
import {
  LANE_HEIGHT,
  MARKER_LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  MAX_FIT_LANE_HEIGHT,
} from "../utils/layout";
import { fitLaneHeight, markerLaneHeight, markerRows } from "./timelineMetrics";

describe("fitLaneHeight", () => {
  it("grows lanes to fill the stage when few tracks fit", () => {
    expect(fitLaneHeight(400, 2)).toBe(200);
  });

  it("caps tall lanes and keeps the default floor", () => {
    expect(fitLaneHeight(2000, 2)).toBe(MAX_FIT_LANE_HEIGHT);
    expect(fitLaneHeight(300, 10)).toBe(LANE_HEIGHT);
  });

  it("falls back to the default before the stage is measured", () => {
    expect(fitLaneHeight(0, 2)).toBe(LANE_HEIGHT);
    expect(fitLaneHeight(-40, 2)).toBe(LANE_HEIGHT);
    expect(fitLaneHeight(500, 0)).toBe(LANE_HEIGHT);
  });
});

describe("marker rows", () => {
  const base = {
    chapters: [],
    socialClips: [],
    comments: [],
    showMarkers: true,
    showComments: true,
  };

  it("collapses to one quiet row when nothing is marked", () => {
    const rows = markerRows(base);
    expect(rows).toEqual({ chapters: false, social: false, comments: false });
    expect(markerLaneHeight(rows)).toBe(MARKER_ROW_HEIGHT);
  });

  it("adds a row per layer with content, honoring layer toggles", () => {
    const chapters = [{ time: 1, title: "Intro" }] as never[];
    const comments = [{ id: "c1" }] as never[];
    expect(markerLaneHeight(markerRows({ ...base, chapters, comments }))).toBe(
      2 * MARKER_ROW_HEIGHT,
    );
    expect(
      markerRows({ ...base, chapters, comments, showComments: false }),
    ).toEqual({ chapters: true, social: false, comments: false });
  });

  it("fills the full marker lane with all three rows", () => {
    expect(
      markerLaneHeight({ chapters: true, social: true, comments: true }),
    ).toBe(MARKER_LANE_HEIGHT);
  });
});
