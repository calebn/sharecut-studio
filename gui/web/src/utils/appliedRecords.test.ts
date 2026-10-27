import { describe, expect, it } from "vitest";
import { appliedEditRecord } from "../test/fixtures";
import { recordAnchors } from "../timeline/appliedEditTicks";
import { isMuteRecord, isRemovalRecord } from "./appliedRecords";

const operations = [
  "ripple_delete",
  "punch_delete",
  "ripple_delete_clips",
  "delete_clips",
  "approve_edits",
  "apply_prefix_edits",
  "edit_selected_range",
  "trim_clip_edge",
  "split_clips_at",
  "approve_split",
  "roll_clip_join",
  "fill_with_room_tone",
  "move_clips",
  "something_legacy",
];

describe("isRemovalRecord", () => {
  it.each(operations)("%s agrees with the timeline tick kind", (operation) => {
    const record = appliedEditRecord({ operation });
    expect(isRemovalRecord(record)).toBe(
      recordAnchors(record, "mira-voice").kind === "seam",
    );
  });

  it("is false for a mute however it is recorded", () => {
    const flagged = appliedEditRecord({ params: { mute: true } });
    const ranged = appliedEditRecord({
      operation: "edit_selected_range",
      params: { action: "mute" },
    });
    expect([flagged, ranged].map(isMuteRecord)).toEqual([true, true]);
    expect([flagged, ranged].map(isRemovalRecord)).toEqual([false, false]);
  });

  it("is true for a ripple delete and false for a trim", () => {
    expect(
      isRemovalRecord(appliedEditRecord({ operation: "ripple_delete" })),
    ).toBe(true);
    expect(
      isRemovalRecord(appliedEditRecord({ operation: "trim_clip_edge" })),
    ).toBe(false);
  });
});
