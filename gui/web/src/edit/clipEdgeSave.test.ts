import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { nudgeClipEdge } from "./clipEdgeSave";

const left = clipRow({
  id: "a",
  track_id: "host",
  source_start: 0,
  source_end: 10,
  timeline_end: 10,
});
const clip = clipRow({
  id: "b",
  track_id: "host",
  source_start: 10,
  source_end: 12,
  timeline_start: 10,
  timeline_end: 12,
  fade_in_ms: 300,
  fade_out_ms: 1500,
});
const project = minimalProject({
  tracks: [sampleTrack({ id: "host", duration_sec: 60, fade_max_ms: null })],
  clips: { tracks: { host: [left, clip] }, clip_count: 2 },
});

describe("nudgeClipEdge", () => {
  it("steps a fade and keeps the other edge", () => {
    expect(nudgeClipEdge(project, clip, "fade", "in", 10)).toEqual({
      kind: "fade",
      inMs: 310,
      outMs: 1500,
    });
    expect(nudgeClipEdge(project, clip, "fade", "out", -1)).toEqual({
      kind: "fade",
      inMs: 300,
      outMs: 1499,
    });
  });

  it("stops a fade where it would overlap the other one, and at zero", () => {
    // 2 s clip, 1.5 s fade out: the fade in can reach 500 ms.
    expect(nudgeClipEdge(project, clip, "fade", "in", 1000)).toEqual({
      kind: "fade",
      inMs: 500,
      outMs: 1500,
    });
    expect(
      nudgeClipEdge(project, { ...clip, fade_in_ms: 0 }, "fade", "in", -10),
    ).toBe(null);
  });

  it("steps a trim and stops it at the neighbour's source end", () => {
    expect(nudgeClipEdge(project, clip, "trim", "in", 0.1)).toEqual({
      kind: "trim",
      edge: "in",
      sourceSec: 10.1,
    });
    expect(nudgeClipEdge(project, clip, "trim", "in", -0.1)).toBe(null);
  });
});
