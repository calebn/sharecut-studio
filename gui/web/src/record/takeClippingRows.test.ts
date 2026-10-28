import { describe, expect, it } from "vitest";
import type { SegmentAckRow } from "./saveStatus";
import { clippingFromRows } from "./takeClippingRows";

const row = (over: Partial<SegmentAckRow> = {}): SegmentAckRow => ({
  participant_id: "p_g",
  acked_parts: [],
  take_index: 0,
  segment_index: 0,
  file_ack: true,
  ...over,
});

describe("clippingFromRows", () => {
  it("is null when the person's rows carry no spans", () => {
    expect(clippingFromRows([], 0, "p_g")).toBeNull();
    expect(
      clippingFromRows([row({ clipping_regions: null })], 0, "p_g"),
    ).toBeNull();
  });

  it("shifts spans by each segment's join offset and orders them across segments", () => {
    const clipping = clippingFromRows(
      [
        row({
          segment_index: 1,
          join_offset_ms: 60_000,
          clipping_regions: [[1000, 2000]],
        }),
        row({ clipping_regions: [[5000, 6000]] }),
      ],
      0,
      "p_g",
    );
    expect(clipping?.regions.map((r) => [r.segmentIndex, r.startMs])).toEqual([
      [0, 5000],
      [1, 61_000],
    ]);
    expect(clipping?.regions[1]?.segmentStartMs).toBe(1000);
    expect(clipping).not.toHaveProperty("truncated");
  });

  it("ignores other takes and other people, and flags a capped segment", () => {
    const rows = [
      row({ clipping_regions: [[1, 2]] }),
      row({ take_index: 1, clipping_regions: [[3, 4]] }),
      row({ participant_id: "p_o", clipping_regions: [[5, 6]] }),
      row({
        segment_index: 1,
        clipping_regions: [[7, 8]],
        clipping_truncated: true,
      }),
    ];
    const clipping = clippingFromRows(rows, 0, "p_g");
    expect(clipping?.regions).toHaveLength(2);
    expect(clipping?.truncated).toBe(true);
    expect(clippingFromRows(rows, 1, "p_g")?.regions).toHaveLength(1);
  });
});
