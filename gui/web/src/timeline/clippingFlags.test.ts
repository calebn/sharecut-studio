import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import { clippingFlags } from "./clippingFlags";

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

describe("clippingFlags", () => {
  it("makes one flag per region, labelled by track, sorted by start", () => {
    const tracks = {
      t1: [
        clip({
          id: "b",
          timeline_start: 200,
          timeline_end: 210,
          clipping_regions: [{ start_s: 12, end_s: 14 }],
        }),
        clip({
          id: "a",
          clipping_regions: [
            { start_s: 11, end_s: 12 },
            { start_s: 15, end_s: 16 },
          ],
        }),
      ],
      t2: [clip({ id: "n" })],
    };
    const flags = clippingFlags(tracks, [{ id: "t1", label: "Ava" }]);
    expect(flags.map((f) => [f.id, f.label, f.start, f.end])).toEqual([
      ["a:0", "Ava", 101, 102],
      ["a:1", "Ava", 105, 106],
      ["b:0", "Ava", 202, 204],
    ]);
  });

  it("falls back to the track id and skips spans outside the clip", () => {
    const flags = clippingFlags(
      { t9: [clip({ clipping_regions: [{ start_s: 50, end_s: 60 }] })] },
      [],
    );
    expect(flags).toEqual([]);
    const shown = clippingFlags(
      { t9: [clip({ clipping_regions: [{ start_s: 11, end_s: 12 }] })] },
      [],
    );
    expect(shown[0]?.label).toBe("t9");
  });
});
