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
  resolveLaneHeight,
  shortTouchFloorPx,
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

describe("resolveLaneHeight", () => {
  it.each(["fixed", "fit"] as const)(
    "preserves independent phone touch targets in %s mode",
    (mode) => {
      expect(
        resolveLaneHeight({
          mode,
          fixedPx: 72,
          availablePx: 300,
          trackCount: 10,
          fit: { kind: "touch" },
        }),
      ).toBe(104);
    },
  );

  it("ignores stage size and track count in fixed mode", () => {
    const fixed = (fixedPx: number) =>
      resolveLaneHeight({
        fit: { kind: "pointer" },
        mode: "fixed",
        fixedPx,
        availablePx: 400,
        trackCount: 2,
      });
    expect(fixed(104)).toBe(104);
    expect(fixed(500)).toBe(240);
    expect(fixed(10)).toBe(72);
  });

  it("delegates to fitLaneHeight in fit mode", () => {
    expect(
      resolveLaneHeight({
        fit: { kind: "pointer" },
        mode: "fit",
        fixedPx: 104,
        availablePx: 400,
        trackCount: 2,
      }),
    ).toBe(200);
    expect(
      resolveLaneHeight({
        fit: { kind: "pointer" },
        mode: "fit",
        fixedPx: 104,
        availablePx: 300,
        trackCount: 10,
      }),
    ).toBe(LANE_HEIGHT);
  });

  describe("on a short touch screen (#1077)", () => {
    const short = (input: {
      mode?: "fixed" | "fit";
      fixedPx?: number;
      floorPx?: number;
      availablePx?: number;
    }) =>
      resolveLaneHeight({
        mode: input.mode ?? "fixed",
        fixedPx: input.fixedPx ?? 104,
        availablePx: input.availablePx ?? 205,
        trackCount: 2,
        fit: { kind: "touchShort", floorPx: input.floorPx ?? 72 },
      });

    it("drops a fixed height to the compact lane, whatever the stage", () => {
      expect(short({})).toBe(72);
      expect(short({ fixedPx: 192, availablePx: 600 })).toBe(72);
    });

    it("still fills the stage in fit mode", () => {
      expect(short({ mode: "fit", availablePx: 300 })).toBe(150);
      expect(short({ mode: "fit", availablePx: 100 })).toBe(72);
    });

    it("keeps large-text identity chips whole", () => {
      expect(shortTouchFloorPx(16)).toBe(72);
      expect(shortTouchFloorPx(32)).toBe(104);
      expect(short({ floorPx: shortTouchFloorPx(32) })).toBe(104);
    });
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
    expect(rows).toEqual({
      chapters: false,
      social: false,
      comments: false,
      clipping: false,
    });
    expect(markerLaneHeight(rows)).toBe(MARKER_ROW_HEIGHT);
  });

  it("gives the quiet row to the tracks on a short touch screen", () => {
    const short = { kind: "touchShort", floorPx: 72 } as const;
    expect(markerLaneHeight(markerRows(base), short)).toBe(0);
    const chapters = [{ time: 1, title: "Intro" }] as never[];
    expect(markerLaneHeight(markerRows({ ...base, chapters }), short)).toBe(
      MARKER_ROW_HEIGHT,
    );
  });

  it("adds a row per layer with content, honoring layer toggles", () => {
    const chapters = [{ time: 1, title: "Intro" }] as never[];
    const comments = [{ id: "c1" }] as never[];
    expect(markerLaneHeight(markerRows({ ...base, chapters, comments }))).toBe(
      2 * MARKER_ROW_HEIGHT,
    );
    expect(
      markerRows({ ...base, chapters, comments, showComments: false }),
    ).toEqual({
      chapters: true,
      social: false,
      comments: false,
      clipping: false,
    });
  });

  it("fills the full marker lane with the three content rows", () => {
    expect(
      markerLaneHeight({
        chapters: true,
        social: true,
        comments: true,
        clipping: false,
      }),
    ).toBe(MARKER_LANE_HEIGHT);
  });

  it("adds a clipping row when recording flags exist and Markers is on", () => {
    const flags = [{ id: "a:0", trackId: "t", label: "T", start: 1, end: 2 }];
    expect(markerRows({ ...base, clippingFlags: flags }).clipping).toBe(true);
    expect(
      markerRows({ ...base, clippingFlags: flags, showMarkers: false })
        .clipping,
    ).toBe(false);
    expect(
      markerLaneHeight({
        chapters: true,
        social: true,
        comments: true,
        clipping: true,
      }),
    ).toBe(4 * MARKER_ROW_HEIGHT);
  });
});
