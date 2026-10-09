import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clampRollDelta, rollNeighborBounds } from "./clipEdgePreview";

describe("recording-aware roll regressions", () => {
  const left = clipRow({
    id: "left",
    source_id: "take-left",
    recording_key: "rec-left",
    source_start: 0,
    source_end: 10,
    source_duration_sec: 30,
    timeline_start: 0,
    timeline_end: 10,
  });
  const right = clipRow({
    id: "right",
    source_id: "take-right",
    recording_key: "rec-right",
    source_start: 10,
    source_end: 20,
    timeline_start: 10,
    timeline_end: 20,
  });
  const after = clipRow({
    id: "after",
    source_id: "take-other",
    recording_key: "rec-other",
    source_start: 11,
    source_end: 15,
    timeline_start: 20,
    timeline_end: 24,
  });

  it.each([
    {
      name: "longer left recording",
      duration: 30,
      trackDuration: 11,
      following: false,
      expected: 3,
    },
    {
      name: "shorter left recording",
      duration: 11,
      trackDuration: 30,
      following: false,
      expected: 1,
    },
    {
      name: "unrelated following recording",
      duration: 30,
      trackDuration: 30,
      following: true,
      expected: 3,
    },
    {
      name: "unknown left duration",
      duration: null,
      trackDuration: 30,
      following: false,
      expected: 0,
    },
  ])("$name", ({ duration, trackDuration, following, expected }) => {
    const l = { ...left, source_duration_sec: duration };
    const project = minimalProject({
      tracks: [sampleTrack({ id: l.track_id, duration_sec: trackDuration })],
      clips: {
        tracks: { [l.track_id]: following ? [l, right, after] : [l, right] },
        clip_count: following ? 3 : 2,
      },
    });
    expect(
      clampRollDelta(3, {
        leftSourceStart: l.source_start,
        leftSourceEnd: l.source_end,
        rightSourceStart: right.source_start,
        rightSourceEnd: right.source_end,
        ...rollNeighborBounds(project, l, right),
      }),
    ).toBe(expected);
  });
});
