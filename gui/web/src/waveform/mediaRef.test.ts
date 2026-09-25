import { describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import { clipMediaRef, clipMediaStartSec, mediaSignature } from "./mediaRef";

const clip: ClipRow = {
  id: "c1",
  track_id: "guest",
  source_start: 10,
  source_end: 20,
  timeline_start: 4,
  timeline_end: 14,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

describe("clipMediaRef", () => {
  const lane = sampleTrack({ id: "guest", stem_is_fresh: true });

  it("uses the lane stem in FX mode only while it is fresh", () => {
    expect(clipMediaRef(clip, lane, "stem")).toBe("stem:guest");
    expect(clipMediaRef(clip, { ...lane, stem_is_fresh: false }, "stem")).toBe(
      "track:guest",
    );
    expect(clipMediaRef(clip, { ...lane, stem_is_fresh: null }, "stem")).toBe(
      "track:guest",
    );
  });

  it("uses the pinned source, else the origin track, for raw", () => {
    expect(clipMediaRef(clip, lane, "raw")).toBe("track:guest");
    expect(
      clipMediaRef({ ...clip, origin_track_id: "host" }, lane, "raw"),
    ).toBe("track:host");
    expect(clipMediaRef({ ...clip, source_id: "s9" }, lane, "raw")).toBe(
      "source:s9",
    );
  });
});

describe("clipMediaStartSec", () => {
  it("is the source start for source media", () => {
    expect(clipMediaStartSec(clip, 12, "track:guest")).toBe(12);
    expect(clipMediaStartSec(clip, 12, "source:s9")).toBe(12);
  });

  it("is on the timeline clock for stems", () => {
    // A 2 s trim-in preview moves the stem start 2 s later on the timeline.
    expect(clipMediaStartSec(clip, 12, "stem:guest")).toBe(6);
    expect(clipMediaStartSec(clip, 10, "stem:guest")).toBe(4);
  });
});

describe("mediaSignature", () => {
  const project = () =>
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: {
        tracks: { host: [{ ...clip, track_id: "host", source_id: "b" }] },
        clip_count: 1,
      },
    });

  it("is empty without a project", () => {
    expect(mediaSignature(null)).toBe("");
  });

  it("changes with media, duration, stem freshness and pinned sources", () => {
    const base = mediaSignature(project());
    expect(mediaSignature(project())).toBe(base);
    const p = project();
    p.tracks[0] = { ...p.tracks[0]!, stem_is_fresh: false };
    expect(mediaSignature(p)).not.toBe(base);
    const q = project();
    q.tracks[0] = { ...q.tracks[0]!, media_path: "raw/other.wav" };
    expect(mediaSignature(q)).not.toBe(base);
    const r = project();
    r.clips.tracks.host!.push({ ...clip, id: "c2", source_id: "a" });
    expect(mediaSignature(r)).not.toBe(base);
  });

  it("ignores clip timing", () => {
    const base = mediaSignature(project());
    const p = project();
    p.clips.tracks.host![0] = {
      ...p.clips.tracks.host![0]!,
      timeline_start: 9,
    };
    expect(mediaSignature(p)).toBe(base);
  });
});
