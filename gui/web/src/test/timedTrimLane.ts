import type { ClipRow, ProjectView } from "../types/project";
import { clipRow, minimalProject, sampleTrack } from "./fixtures";

/**
 * A lane where a timing correction leaves clip `a`'s out edge no legal range:
 * the skip at 15 s keeps the edge at 15.500001 s or later, and the next clip of
 * the same recording starts at 15.2 s. `trim_edge_limits` gives `[15.500001,
 * 15.2]` for it (`contracts/trim-edge-limits.json`, "inverted out"). The same
 * lane without the skip is an ordinary trim.
 */
export function noRangeLane(timed = true): ClipRow[] {
  return [
    clipRow({
      id: "a",
      track_id: "host",
      source_start: 10,
      source_end: 20,
      source_duration_sec: 600,
      timeline_start: 0,
      timeline_end: timed ? 9.5 : 10,
      ...(timed
        ? {
            timing: {
              steps: [{ at: 15, delta_sec: -0.5 }],
              method: "cut",
              micro_fade_ms: 0,
            },
          }
        : {}),
    }),
    clipRow({
      id: "b",
      track_id: "host",
      source_start: 15.2,
      source_end: 25,
      source_duration_sec: 600,
      timeline_start: 12,
      timeline_end: 21.8,
    }),
  ];
}

export function noRangeProject(timed = true): ProjectView {
  return minimalProject({
    tracks: [sampleTrack({ id: "host", duration_sec: 600 })],
    clips: { tracks: { host: noRangeLane(timed) }, clip_count: 2 },
  });
}

/**
 * One clip, source 10..20, with a skip of 0.5 s at 15 s: `trim_edge_limits` gives
 * its out edge `[15.500001, 600]` and its in edge `[0, 14.999999]`.
 */
export function skipProject(): ProjectView {
  return minimalProject({
    tracks: [sampleTrack({ id: "host", duration_sec: 600 })],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "a",
            track_id: "host",
            source_start: 10,
            source_end: 20,
            source_duration_sec: 600,
            timeline_start: 0,
            timeline_end: 9.5,
            timing: {
              steps: [{ at: 15, delta_sec: -0.5 }],
              method: "cut",
              micro_fade_ms: 0,
            },
          }),
        ],
      },
      clip_count: 1,
    },
  });
}

/**
 * An UNTIMED lane where the next clip of the same recording starts inside the
 * first clip's minimum span, so `a`'s out edge is `[10.05, 10.02]` (no legal
 * range) and `b`'s in edge is `[20, 19.97]`.
 */
export function overlapLane(): ClipRow[] {
  return [
    clipRow({
      id: "a",
      track_id: "host",
      source_start: 10,
      source_end: 20,
      source_duration_sec: 600,
      timeline_start: 0,
      timeline_end: 10,
    }),
    clipRow({
      id: "b",
      track_id: "host",
      source_start: 10.02,
      source_end: 20.02,
      source_duration_sec: 600,
      timeline_start: 10,
      timeline_end: 20,
    }),
  ];
}
