import { describe, expect, it } from "vitest";
import type { ClipRow, TrackView } from "../types/project";
import {
  computeClipMoves,
  laneMovePreview,
  movesDifferFromClips,
  patchClipsMove,
  snapMoveDeltaSec,
  waveformTicksToTimeline,
} from "./clipMove";

function clip(id: string, trackId: string, start: number, dur = 2): ClipRow {
  return {
    id,
    track_id: trackId,
    source_start: 0,
    source_end: dur,
    timeline_start: start,
    timeline_end: start + dur,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
  };
}

const tracks: TrackView[] = [
  {
    id: "host",
    label: "Host",
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 40,
    fx_count: 0,
    stem_is_fresh: true,
    media_path: "raw/host.wav",
  },
  {
    id: "guest",
    label: "Guest",
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 40,
    fx_count: 0,
    stem_is_fresh: true,
    media_path: "raw/guest.wav",
  },
  {
    id: "bed",
    label: "Bed",
    role: "music",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 40,
    fx_count: 0,
    stem_is_fresh: true,
    media_path: "raw/bed.wav",
  },
];

describe("computeClipMoves", () => {
  const clips = [
    clip("c1", "host", 0),
    clip("c2", "host", 5),
    clip("g1", "guest", 1),
  ];
  const trackIds = tracks.map((t) => t.id);

  it("shifts a rigid group on the same track", () => {
    const moves = computeClipMoves({
      clips,
      trackIds,
      movingIds: ["c1", "c2"],
      anchorId: "c1",
      destTrackId: "host",
      deltaSec: 2,
    });
    expect(moves).toEqual([
      { clip_id: "c1", timeline_start: 2, track_id: "host" },
      { clip_id: "c2", timeline_start: 7, track_id: "host" },
    ]);
  });

  it("applies lane-index delta for an inter-track group", () => {
    const moves = computeClipMoves({
      clips,
      trackIds,
      movingIds: ["c1", "g1"],
      anchorId: "c1",
      destTrackId: "guest",
      deltaSec: 0.5,
    });
    expect(moves).toEqual([
      { clip_id: "c1", timeline_start: 0.5, track_id: "guest" },
      { clip_id: "g1", timeline_start: 1.5, track_id: "bed" },
    ]);
  });

  it("clamps lane delta to the last track", () => {
    const moves = computeClipMoves({
      clips,
      trackIds,
      movingIds: ["g1"],
      anchorId: "g1",
      destTrackId: "bed",
      deltaSec: 0,
    });
    expect(moves[0]?.track_id).toBe("bed");
    const over = computeClipMoves({
      clips,
      trackIds,
      movingIds: ["c1", "g1"],
      anchorId: "g1",
      destTrackId: "bed",
      deltaSec: 0,
    });
    expect(over.find((m) => m.clip_id === "c1")?.track_id).toBe("guest");
    expect(over.find((m) => m.clip_id === "g1")?.track_id).toBe("bed");
  });

  it("clamps timeline_start at 0", () => {
    const moves = computeClipMoves({
      clips,
      trackIds,
      movingIds: ["c1"],
      anchorId: "c1",
      destTrackId: "host",
      deltaSec: -10,
    });
    expect(moves[0]?.timeline_start).toBe(0);
  });

  it("replaces an unselected anchor with a one-clip set", () => {
    const moves = computeClipMoves({
      clips,
      trackIds,
      movingIds: ["c2"],
      anchorId: "c1",
      destTrackId: "guest",
      deltaSec: 1,
    });
    expect(moves).toEqual([
      { clip_id: "c1", timeline_start: 1, track_id: "guest" },
    ]);
  });
});

describe("snapMoveDeltaSec", () => {
  it("snaps clip start to a nearby tick", () => {
    const delta = snapMoveDeltaSec({
      anchorStart: 1,
      anchorEnd: 3,
      deltaSec: 0.04,
      ticks: [1.05],
      zoomPxPerSec: 100,
    });
    expect(1 + delta).toBeCloseTo(1.05, 5);
  });

  it("prefers snapping the clip end when that is closer", () => {
    const delta = snapMoveDeltaSec({
      anchorStart: 0,
      anchorEnd: 2,
      deltaSec: 0.04,
      ticks: [2.05],
      zoomPxPerSec: 100,
    });
    expect(2 + delta).toBeCloseTo(2.05, 5);
  });
});

describe("patchClipsMove / laneMovePreview", () => {
  it("reindexes clips onto the destination track", () => {
    const project = {
      timeline_duration_sec: 10,
      tracks,
      clips: {
        clip_count: 2,
        tracks: {
          host: [clip("c1", "host", 0)],
          guest: [clip("g1", "guest", 1)],
          bed: [],
        },
      },
    };
    const next = patchClipsMove(project, [
      { clip_id: "c1", timeline_start: 3, track_id: "guest" },
    ]);
    expect(next.clips.tracks.host).toEqual([]);
    expect(next.clips.tracks.guest?.map((c) => c.id)).toEqual(["g1", "c1"]);
    expect(next.clips.tracks.guest?.[1]?.timeline_start).toBe(3);
    expect(next.clips.tracks.guest?.[1]?.origin_track_id).toBe("host");
    expect(next.timeline_duration_sec).toBe(5);
  });

  it("hides origin clips and emits dest-lane ghosts", () => {
    const all = [clip("c1", "host", 0), clip("g1", "guest", 1)];
    const preview = laneMovePreview({
      trackId: "guest",
      laneClips: [all[1]!],
      allClips: all,
      tracks,
      placements: [{ clip_id: "c1", timeline_start: 4, track_id: "guest" }],
    });
    expect(preview.ghosts).toHaveLength(1);
    expect(preview.ghosts[0]?.clip.timeline_start).toBe(4);
    expect(preview.ghosts[0]?.mediaPath).toBe("raw/host.wav");
    const origin = laneMovePreview({
      trackId: "host",
      laneClips: [all[0]!],
      allClips: all,
      tracks,
      placements: [{ clip_id: "c1", timeline_start: 4, track_id: "guest" }],
    });
    expect([...origin.hideIds]).toEqual(["c1"]);
  });

  it("reports no-op moves", () => {
    const clips = [clip("c1", "host", 2)];
    expect(
      movesDifferFromClips(clips, [
        { clip_id: "c1", timeline_start: 2, track_id: "host" },
      ]),
    ).toBe(false);
    expect(
      movesDifferFromClips(clips, [
        { clip_id: "c1", timeline_start: 2.5, track_id: "host" },
      ]),
    ).toBe(true);
  });

  it("converts waveform ticks into timeline seconds", () => {
    expect(waveformTicksToTimeline(clip("c1", "host", 5, 2), [0.5, 1])).toEqual(
      [5.5, 6],
    );
  });
});

describe("trackIdFromPoint", () => {
  it("reads data-track-id from the element under the cursor", async () => {
    const { trackIdFromPoint } = await import("./clipMove");
    const lane = document.createElement("div");
    lane.setAttribute("data-track-id", "guest");
    const inner = document.createElement("span");
    lane.appendChild(inner);
    document.body.appendChild(lane);
    document.elementFromPoint = () => inner;
    expect(trackIdFromPoint(10, 10)).toBe("guest");
    lane.remove();
  });
});
