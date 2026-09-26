import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import { sourceToTimeline, sourceToTimelineSec } from "./clippingFlags";

const clip = (over: Partial<ClipRow> = {}): ClipRow => ({
  id: "c1",
  track_id: "t1",
  source_start: 10,
  source_end: 20,
  timeline_start: 100,
  timeline_end: 110,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: "rec-a-0-p_host-0",
  ...over,
});

describe("sourceToTimelineSec", () => {
  it("maps inside the clip and rejects outside", () => {
    expect(sourceToTimelineSec(clip(), 12)).toBe(102);
    expect(sourceToTimelineSec(clip(), 9)).toBeNull();
    expect(sourceToTimelineSec(clip(), 21)).toBeNull();
  });
});

describe("sourceToTimeline", () => {
  it("finds the clip showing the source second", () => {
    const tracks = {
      t1: [
        clip({
          id: "a",
          source_start: 0,
          source_end: 5,
          timeline_start: 0,
          timeline_end: 5,
        }),
        clip({ id: "b" }),
      ],
    };
    const hit = sourceToTimeline(tracks, "rec-a-0-p_host-0", 15);
    expect(hit?.clip.id).toBe("b");
    expect(hit?.timelineSec).toBe(105);
    expect(hit?.trackId).toBe("t1");
  });

  it("returns null for other sources or cut-out spans", () => {
    const tracks = { t1: [clip()] };
    expect(sourceToTimeline(tracks, "other", 15)).toBeNull();
    expect(sourceToTimeline(tracks, "rec-a-0-p_host-0", 50)).toBeNull();
  });
});
