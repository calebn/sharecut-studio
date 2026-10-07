import { describe, expect, it } from "vitest";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { type NudgeField, nudgeAxis, nudgeStep, withNudge } from "./nudge";
import { softBoundaries } from "./nudgeBoundaries";

const left = clipRow({
  id: "a",
  track_id: "host",
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
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
const right = clipRow({
  id: "c",
  track_id: "host",
  source_start: 12,
  source_end: 40,
  timeline_start: 12,
  timeline_end: 40,
});
const project: ProjectView = minimalProject({
  tracks: [sampleTrack({ id: "host", duration_sec: 60, fade_max_ms: null })],
  clips: { tracks: { host: [left, clip, right] }, clip_count: 3 },
  pending_edits: [
    pendingEditView({
      id: "p1",
      track_id: "host",
      track_ids: ["host"],
      source_start: 20,
      source_end: 23.95,
      source_start_timeline: 20,
      source_end_timeline: 23.95,
      timeline_start: 20,
      timeline_end: 23.95,
      timeline_spans: [{ start: 20, end: 23.95 }],
    }),
    pendingEditView({
      id: "p2",
      track_id: "host",
      track_ids: ["host"],
      source_start: 24,
      source_end: 28,
      source_start_timeline: 24,
      source_end_timeline: 28,
      timeline_start: 24,
      timeline_end: 28,
      timeline_spans: [{ start: 24, end: 28 }],
    }),
  ],
  envelopes: [
    {
      track_id: "host",
      parameter: "volume",
      points: [
        { id: "e1", time: 9.95, value: 1.45 },
        { id: "e2", time: 10.5, value: 1 },
      ],
    },
  ],
});

/** Steps `field` by `delta`, held or fresh, against the soft boundaries. */
function nudge(
  field: NudgeField,
  delta: number,
  held: boolean,
  playheadSec: number | null = null,
  from?: number,
) {
  const axis = nudgeAxis(project, field);
  if (!axis) throw new Error("no axis");
  const boundaries = axis.mover
    ? softBoundaries(project, axis.mover, playheadSec)
    : [];
  return nudgeStep(axis, boundaries, from ?? axis.value, delta, held);
}

const fadeIn: NudgeField = {
  kind: "fade",
  trackId: "host",
  clipId: "b",
  edge: "in",
};
const trimIn: NudgeField = {
  kind: "trim",
  trackId: "host",
  clipId: "b",
  edge: "in",
};
const pointTime: NudgeField = {
  kind: "envelope-time",
  trackId: "host",
  pointId: "e1",
};
const pointLevel: NudgeField = {
  kind: "envelope-level",
  trackId: "host",
  pointId: "e1",
};
const pendingEnd: NudgeField = {
  kind: "pending",
  trackId: "host",
  editId: "p1",
  edge: "end",
};

describe("nudgeStep", () => {
  it("steps a fade, and stops it where it would overlap the other fade or at zero", () => {
    expect(nudge(fadeIn, 10, false)).toEqual({ value: 310, stop: null });
    // 2 s clip, 1.5 s fade out: the fade in can reach 500 ms.
    expect(nudge(fadeIn, 1000, false)).toEqual({
      value: 500,
      stop: { kind: "limit" },
    });
    expect(nudge(fadeIn, -10, true, null, 0)).toEqual({
      value: 0,
      stop: { kind: "limit" },
    });
  });

  it("steps a trim and stops it at the neighbour's source end", () => {
    expect(nudge(trimIn, 0.1, false)).toEqual({ value: 10.1, stop: null });
    expect(nudge(trimIn, -0.1, false)).toEqual({
      value: 10,
      stop: { kind: "limit" },
    });
  });

  it("stops a held step exactly at a neighbouring clip edge; a fresh press crosses it", () => {
    expect(nudge(pointTime, 0.1, true)).toEqual({
      value: 10,
      stop: { kind: "boundary", boundary: { sec: 10, label: "a clip edge" } },
    });
    expect(nudge(pointTime, 0.1, false)).toEqual({ value: 10.05, stop: null });
    // A held run that starts on the edge moves off it freely.
    expect(nudge(pointTime, 0.1, true, null, 10)).toEqual({
      value: 10.1,
      stop: null,
    });
  });

  it("stops a held pending edge at the adjacent pending edit; a fresh press crosses it", () => {
    expect(nudge(pendingEnd, 0.1, true)).toEqual({
      value: 24,
      stop: {
        kind: "boundary",
        boundary: { sec: 24, label: "the pending remove" },
      },
    });
    expect(nudge(pendingEnd, 0.1, false)).toEqual({
      value: 24.05,
      stop: null,
    });
  });

  it("stops a held step at the playhead", () => {
    expect(nudge(pointTime, -0.1, true, 9.9)).toMatchObject({
      value: 9.9,
      stop: { kind: "boundary", boundary: { label: "the playhead" } },
    });
  });

  it("never crosses a hard limit, held or fresh: point order and the level range", () => {
    for (const held of [true, false]) {
      expect(nudge(pointTime, 0.1, held, null, 10.45)).toEqual({
        value: 10.499,
        stop: { kind: "limit" },
      });
      expect(nudge(pointLevel, 0.1, held)).toEqual({
        value: 1.5,
        stop: { kind: "limit" },
      });
    }
  });
});

describe("withNudge", () => {
  it("previews a trim as a ripple: later clips on the track move with its end", () => {
    const trimOut: NudgeField = { ...trimIn, edge: "out" };
    const next = withNudge(project, trimOut, 12.5);
    expect(
      next.clips.tracks.host.map((c) => [
        c.id,
        c.timeline_start,
        c.timeline_end,
      ]),
    ).toEqual([
      ["a", 0, 10],
      ["b", 10, 12.5],
      ["c", 12.5, 40.5],
    ]);
  });

  it("previews a trim on every dialogue track the ripple moves", () => {
    const guestClip = clipRow({
      id: "g",
      track_id: "guest",
      source_start: 0,
      source_end: 40,
      timeline_start: 0,
      timeline_end: 40,
    });
    const bed = clipRow({
      id: "m",
      track_id: "music",
      source_start: 0,
      source_end: 40,
      timeline_start: 0,
      timeline_end: 40,
    });
    const multi = minimalProject({
      ...project,
      tracks: [
        ...project.tracks,
        sampleTrack({ id: "guest" }),
        sampleTrack({ id: "music", role: "music" }),
      ],
      clips: {
        tracks: { ...project.clips.tracks, guest: [guestClip], music: [bed] },
        clip_count: 5,
      },
    });
    const next = withNudge(multi, { ...trimIn, edge: "out" }, 11.5);
    const spans = (trackId: string) =>
      next.clips.tracks[trackId].map((c) => [
        c.timeline_start,
        c.timeline_end,
        c.source_start,
        c.source_end,
      ]);
    expect(spans("host")).toEqual([
      [0, 10, 0, 10],
      [10, 11.5, 10, 11.5],
      [11.5, 39.5, 12, 40],
    ]);
    // The guest loses the same half second the host's clip does.
    expect(spans("guest")).toEqual([
      [0, 11.5, 0, 11.5],
      [11.5, 39.5, 12, 40],
    ]);
    expect(spans("music")).toEqual([[0, 40, 0, 40]]);
  });

  it("previews a pending edge on its region and an envelope point in order", () => {
    const pending = withNudge(project, pendingEnd, 24.05).pending_edits[0];
    expect([
      pending.source_end,
      pending.timeline_end,
      pending.timeline_spans,
    ]).toEqual([24.05, 24.05, [{ start: 20, end: 24.05 }]]);
    expect(withNudge(project, pointLevel, 0.5).envelopes[0].points).toEqual([
      { id: "e1", time: 9.95, value: 0.5 },
      { id: "e2", time: 10.5, value: 1 },
    ]);
  });
});

describe("nudgeAxis", () => {
  it("has no field for a pending split or a missing target", () => {
    const split = minimalProject({
      ...project,
      pending_edits: [
        pendingEditView({ id: "s1", track_id: "host", type: "split" }),
      ],
    });
    expect(
      nudgeAxis(split, {
        kind: "pending",
        trackId: "host",
        editId: "s1",
        edge: "start",
      }),
    ).toBeNull();
    expect(nudgeAxis(project, { ...fadeIn, clipId: "gone" })).toBeNull();
  });
});
