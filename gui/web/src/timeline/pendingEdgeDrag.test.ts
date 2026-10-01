import { describe, expect, it } from "vitest";
import { clipRow } from "../test/fixtures";
import {
  pendingEdgePlacement,
  pendingEdgePreview,
  pendingOuterEndpoint,
} from "./pendingEdgeDrag";

describe("pending edge projection", () => {
  it("requires the stored source and projected timeline point to identify one real clip", () => {
    const first = clipRow({
      id: "first",
      source_start: 0,
      source_end: 4,
      timeline_start: 0,
      timeline_end: 4,
    });
    const repeated = clipRow({
      id: "repeated",
      source_start: 0,
      source_end: 4,
      timeline_start: 8,
      timeline_end: 12,
    });
    expect(pendingEdgePlacement([first, repeated], 2, 2)).toEqual({
      kind: "clip",
      clip: first,
    });
    expect(pendingEdgePlacement([first, repeated], 2, 5)).toBeNull();
    expect(pendingEdgePlacement([], 2, 2)).toEqual({ kind: "identity" });
  });

  it("moves one edge at unit rate, snaps it, and keeps the other source edge fixed", () => {
    const placement = {
      kind: "clip" as const,
      clip: clipRow({
        source_start: 0,
        source_end: 10,
        timeline_start: 20,
        timeline_end: 30,
      }),
    };
    expect(
      pendingEdgePreview({
        edge: "end",
        sourceStart: 2,
        sourceEnd: 4,
        sourceDeltaSec: 0.3,
        placement,
        ticks: [4.25],
        zoomPxPerSec: 100,
      }),
    ).toEqual({ sourceStart: 2, sourceEnd: 4.25, timelinePoint: 24.25 });
  });

  it("keeps both moved endpoints inside the matched clip placement", () => {
    const placement = {
      kind: "clip" as const,
      clip: clipRow({
        source_start: 2,
        source_end: 6,
        timeline_start: 10,
        timeline_end: 14,
      }),
    };
    const start = pendingEdgePreview({
      edge: "start",
      sourceStart: 3,
      sourceEnd: 8,
      sourceDeltaSec: 20,
      placement,
      ticks: [],
      zoomPxPerSec: 100,
    });
    expect(start).toEqual({ sourceStart: 6, sourceEnd: 8, timelinePoint: 14 });
    const end = pendingEdgePreview({
      edge: "end",
      sourceStart: 0,
      sourceEnd: 5,
      sourceDeltaSec: -20,
      placement,
      ticks: [],
      zoomPxPerSec: 100,
    });
    expect(end).toEqual({ sourceStart: 0, sourceEnd: 2, timelinePoint: 10 });
  });

  it("allows identity mapping, rejects clipped endpoints, and recognizes only outer edges", () => {
    expect(
      pendingEdgePreview({
        edge: "start",
        sourceStart: 2,
        sourceEnd: 4,
        sourceDeltaSec: -1,
        placement: { kind: "identity" },
        ticks: [],
        zoomPxPerSec: 100,
      }),
    ).toEqual({ sourceStart: 1, sourceEnd: 4, timelinePoint: 1 });
    expect(pendingOuterEndpoint("start", null, 1, 5)).toBe(false);
    expect(pendingOuterEndpoint("start", 3, 1, 5)).toBe(false);
    expect(pendingOuterEndpoint("end", 5, 1, 5)).toBe(true);
  });
});
