import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import {
  clipsForOriginTrack,
  sourceIdPointToTimeline,
  sourcePointToTimeline,
  sourceSecInClipToTimeline,
  sourceSecOnClipToTimeline,
  timelinePointToSource,
} from "./timebase";

function clip(
  partial: Pick<
    ClipRow,
    "source_start" | "source_end" | "timeline_start" | "timeline_end"
  > &
    Partial<ClipRow>,
): ClipRow {
  return {
    id: partial.id ?? "c",
    track_id: partial.track_id ?? "t1",
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    ...partial,
  };
}

/** Source [0–2] @ tl [0–2], then source [5–8] @ tl [2–5] (gap 2–5 cut away). */
const clips: ClipRow[] = [
  clip({
    id: "a",
    source_start: 0,
    source_end: 2,
    timeline_start: 0,
    timeline_end: 2,
  }),
  clip({
    id: "b",
    source_start: 5,
    source_end: 8,
    timeline_start: 2,
    timeline_end: 5,
  }),
];

describe("timelinePointToSource", () => {
  it("maps inside first clip", () => {
    expect(timelinePointToSource(clips, 0)).toBe(0);
    expect(timelinePointToSource(clips, 1.5)).toBe(1.5);
  });

  it("maps inside second clip after a cut", () => {
    expect(timelinePointToSource(clips, 2)).toBe(5);
    expect(timelinePointToSource(clips, 4)).toBe(7);
  });

  it("returns null in timeline gaps / past end", () => {
    expect(timelinePointToSource(clips, 5)).toBeNull();
    expect(timelinePointToSource(clips, 9)).toBeNull();
    expect(timelinePointToSource([], 1)).toBeNull();
  });
});

describe("sourcePointToTimeline", () => {
  it("maps source inside kept clips", () => {
    expect(sourcePointToTimeline(clips, 0)).toBe(0);
    expect(sourcePointToTimeline(clips, 1.5)).toBe(1.5);
    expect(sourcePointToTimeline(clips, 5)).toBe(2);
    expect(sourcePointToTimeline(clips, 7)).toBe(4);
  });

  it("returns null for cut-away source", () => {
    expect(sourcePointToTimeline(clips, 3)).toBeNull();
    expect(sourcePointToTimeline(clips, 9)).toBeNull();
  });
});

describe("clipsForOriginTrack", () => {
  it("includes clips parked on another lane", () => {
    const tracks = {
      host: [] as ClipRow[],
      guest: [
        clip({
          id: "c1",
          track_id: "guest",
          origin_track_id: "host",
          source_start: 0,
          source_end: 2,
          timeline_start: 1,
          timeline_end: 3,
        }),
      ],
    };
    expect(clipsForOriginTrack(tracks, "host").map((c) => c.id)).toEqual([
      "c1",
    ]);
    expect(clipsForOriginTrack(tracks, "guest")).toEqual([]);
  });
});

describe("sourceSecOnClipToTimeline", () => {
  it("maps a source second on one clip without bounds clipping", () => {
    expect(sourceSecOnClipToTimeline(clips[0]!, 10)).toBe(10);
  });
});

describe("sourceSecInClipToTimeline", () => {
  const c = clip({
    source_start: 10,
    source_end: 20,
    timeline_start: 100,
    timeline_end: 110,
  });
  it("maps inside the clip, includes both ends and rejects outside", () => {
    expect(sourceSecInClipToTimeline(c, 12)).toBe(102);
    expect(sourceSecInClipToTimeline(c, 20)).toBe(110);
    expect(sourceSecInClipToTimeline(c, 9)).toBeNull();
    expect(sourceSecInClipToTimeline(c, 21)).toBeNull();
  });
});

describe("sourceIdPointToTimeline", () => {
  const src = "rec-a-0-p_host-0";
  const later = clip({
    id: "b",
    source_id: src,
    source_start: 10,
    source_end: 20,
    timeline_start: 100,
    timeline_end: 110,
  });
  it("finds the clip showing the source second", () => {
    const tracks = {
      t1: [
        clip({
          id: "a",
          source_id: src,
          source_start: 0,
          source_end: 5,
          timeline_start: 0,
          timeline_end: 5,
        }),
        later,
      ],
    };
    const hit = sourceIdPointToTimeline(tracks, src, 15);
    expect(hit?.clip.id).toBe("b");
    expect(hit?.timelineSec).toBe(105);
    expect(hit?.trackId).toBe("t1");
  });
  it("returns null for other sources or cut-out spans", () => {
    const tracks = { t1: [later] };
    expect(sourceIdPointToTimeline(tracks, "other", 15)).toBeNull();
    expect(sourceIdPointToTimeline(tracks, src, 50)).toBeNull();
  });
});
