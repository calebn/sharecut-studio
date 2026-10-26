import { describe, expect, it } from "vitest";
import { attentionRegionLabel } from "./attentionLabel";

describe("attentionRegionLabel", () => {
  it("joins pending, conflicts, and failure flags", () => {
    expect(
      attentionRegionLabel({
        pending: 1,
        conflictCount: 2,
        unreadable: false,
        dismissFailed: false,
      }),
    ).toBe("Needs attention. 1 pending, 2 conflicts");
    expect(
      attentionRegionLabel({
        pending: 0,
        conflictCount: 0,
        unreadable: true,
        dismissFailed: true,
      }),
    ).toBe("Needs attention. Saved edits could not be read. Dismissal failed");
  });
});
