import { describe, expect, it } from "vitest";
import { attentionRegionLabel } from "./attentionLabel";

describe("attentionRegionLabel", () => {
  it("counts a guest's kept and refused comments in words", () => {
    expect(
      attentionRegionLabel({
        pending: 0,
        waitingPosts: 2,
        returnedPosts: 1,
        conflictCount: 0,
        unreadable: false,
        dismissFailed: false,
      }),
    ).toBe("Needs attention. 2 waiting to send, 1 not posted");
  });

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
