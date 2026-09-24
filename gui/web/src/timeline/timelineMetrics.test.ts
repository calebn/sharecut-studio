import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  LANE_HEIGHT,
  MARKER_LANE_HEIGHT,
  MARKER_ROW_HEIGHT,
  MAX_FIT_LANE_HEIGHT,
} from "../utils/layout";
import {
  fitLaneHeight,
  markerLaneHeight,
  markerRows,
  useGestureStable,
} from "./timelineMetrics";

describe("useGestureStable", () => {
  function setup() {
    return renderHook(({ live }) => useGestureStable(live), {
      initialProps: { live: { laneHeight: 150 } },
    });
  }

  it("follows live values when nothing holds", () => {
    const { result, rerender } = setup();
    rerender({ live: { laneHeight: 120 } });
    expect(result.current.value).toEqual({ laneHeight: 120 });
  });

  it("freezes while held and catches up on release", () => {
    const { result, rerender } = setup();
    let release: (() => void) | undefined;
    act(() => {
      release = result.current.hold();
    });
    // A collaborator's update re-fits the lanes mid-drag.
    rerender({ live: { laneHeight: 96 } });
    expect(result.current.value).toEqual({ laneHeight: 150 });
    act(() => release?.());
    expect(result.current.value).toEqual({ laneHeight: 96 });
  });

  it("stays frozen until every hold is released, once each", () => {
    const { result, rerender } = setup();
    let first: (() => void) | undefined;
    let second: (() => void) | undefined;
    act(() => {
      first = result.current.hold();
      second = result.current.hold();
    });
    rerender({ live: { laneHeight: 96 } });
    act(() => {
      first?.();
      first?.();
    });
    expect(result.current.value).toEqual({ laneHeight: 150 });
    act(() => second?.());
    expect(result.current.value).toEqual({ laneHeight: 96 });
  });
});

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
