import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow, ProjectView, Selection } from "../types/project";
import { makeRangeTarget } from "./rangeSelection";
import {
  guessSegmentKind,
  NO_SEGMENT_SELECTION,
  segmentSelectionOf,
  segmentSummary,
} from "./segmentSelection";

function project(clips: ClipRow[], duration = 1000): ProjectView {
  const ids = [...new Set(clips.map((clip) => clip.track_id))];
  return minimalProject({
    timeline_duration_sec: duration,
    tracks: ids.map((id) => sampleTrack({ id })),
    clips: {
      tracks: Object.fromEntries(
        ids.map((id) => [id, clips.filter((clip) => clip.track_id === id)]),
      ),
      clip_count: clips.length,
    },
  });
}

const one = clipRow({
  id: "a",
  track_id: "t1",
  timeline_start: 300,
  timeline_end: 322,
});
const two = clipRow({
  id: "b",
  track_id: "t2",
  timeline_start: 301,
  timeline_end: 320,
});

describe("guessSegmentKind", () => {
  it("is intro in the first two minutes, outro in the last two, else other", () => {
    expect(guessSegmentKind(0, 22, 1000)).toBe("intro");
    expect(guessSegmentKind(120, 150, 1000)).toBe("intro");
    expect(guessSegmentKind(121, 150, 1000)).toBe("other");
    expect(guessSegmentKind(900, 1000, 1000)).toBe("outro");
    expect(guessSegmentKind(800, 879, 1000)).toBe("other");
  });
});

describe("segmentSummary", () => {
  it("counts clips and reads the length as m:ss", () => {
    expect(segmentSummary(3, 22)).toBe("3 clips, 0:22");
    expect(segmentSummary(1, 65)).toBe("1 clip, 1:05");
  });
});

describe("segmentSelectionOf", () => {
  it("maps a clip selection to clip_ids with its span", () => {
    const selection: Selection = {
      kind: "clip",
      id: "a",
      trackId: "t1",
      ids: ["a", "b"],
    };
    expect(segmentSelectionOf(project([one, two]), selection)).toMatchObject({
      ok: true,
      request: { clip_ids: ["a", "b"] },
      clipCount: 2,
      startSec: 300,
      endSec: 322,
      defaultKind: "other",
      summary: "2 clips, 0:22",
    });
  });

  it("guesses intro from a clip at the start", () => {
    const early = clipRow({
      id: "e",
      track_id: "t1",
      timeline_start: 0,
      timeline_end: 10,
    });
    const found = segmentSelectionOf(project([early]), {
      kind: "clip",
      id: "e",
      trackId: "t1",
    });
    expect(found).toMatchObject({ ok: true, defaultKind: "intro" });
  });

  it("refuses a clip that is no longer there", () => {
    expect(
      segmentSelectionOf(project([one]), {
        kind: "clip",
        id: "zz",
        trackId: "t1",
      }),
    ).toEqual({ ok: false, reason: "The selected clips changed" });
  });

  it("maps a range over every track to one time_range", () => {
    const p = project([one, two]);
    const target = makeRangeTarget(
      p,
      [{ start: 301.5, end: 315 }],
      ["t1", "t2"],
    )!;
    expect(segmentSelectionOf(p, { kind: "range", target })).toMatchObject({
      ok: true,
      request: { time_range: "301.500-315.000" },
      clipCount: 2,
      summary: "2 clips, 0:14",
    });
  });

  it("refuses a range that leaves a track out, since a segment keeps them all", () => {
    const p = project([one, two]);
    const target = makeRangeTarget(p, [{ start: 301.5, end: 315 }], ["t1"])!;
    expect(segmentSelectionOf(p, { kind: "range", target })).toEqual({
      ok: false,
      reason: "A segment keeps every track. Widen the range to all tracks",
    });
  });

  it("never counts a track that has audio but no clips as a clip", () => {
    const base = project([one]);
    const p = {
      ...base,
      tracks: [
        ...base.tracks,
        sampleTrack({ id: "t9", has_source_audio: true, duration_sec: 900 }),
      ],
    };
    const target = makeRangeTarget(
      p,
      [{ start: 301.5, end: 315 }],
      ["t1", "t9"],
    )!;
    expect(segmentSelectionOf(p, { kind: "range", target })).toMatchObject({
      ok: true,
      clipCount: 1,
      request: { time_range: "301.500-315.000" },
    });
    expect(
      segmentSelectionOf(p, {
        kind: "clip",
        id: "clip_t9_full",
        trackId: "t9",
      }),
    ).toMatchObject({ ok: false });
  });

  it("refuses a range of several stretches", () => {
    const p = project([one, two]);
    const target = makeRangeTarget(
      p,
      [
        { start: 301, end: 305 },
        { start: 310, end: 315 },
      ],
      ["t1", "t2"],
    )!;
    expect(segmentSelectionOf(p, { kind: "range", target })).toEqual({
      ok: false,
      reason: "Select one stretch of time to save",
    });
  });

  it("refuses everything else", () => {
    expect(segmentSelectionOf(project([one]), null)).toEqual({
      ok: false,
      reason: NO_SEGMENT_SELECTION,
    });
    expect(
      segmentSelectionOf(project([one]), { kind: "track", trackId: "t1" }),
    ).toEqual({ ok: false, reason: NO_SEGMENT_SELECTION });
    expect(segmentSelectionOf(null, null).ok).toBe(false);
  });
});
