import { describe, expect, it } from "vitest";
import { pendingEditView } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import {
  bulkReviewDoneMessage,
  bulkReviewQuestion,
  pendingReviewFeedback,
  reviewPassOf,
} from "./pendingReviewPass";

const waiting = (id: string, track: string, extra = {}) =>
  pendingEditView({
    id,
    track_id: track,
    track_ids: [track],
    review_required: true,
    ...extra,
  });

describe("reviewPassOf", () => {
  it("counts only the edits waiting on a person, and the tracks they touch", () => {
    const pass = reviewPassOf([
      waiting("a", "host"),
      waiting("b", "host"),
      waiting("c", "guest"),
      waiting("d", "other", { review_required: false }),
    ]);
    expect(pass).toEqual({
      ids: ["a", "b", "c"],
      trackCount: 2,
      riskyCount: 0,
    });
  });

  it("counts a ripple that spans tracks on every track it touches", () => {
    const pass = reviewPassOf([
      waiting("a", "host", { track_ids: ["host", "guest", "music"] }),
    ]);
    expect(pass.trackCount).toBe(3);
  });

  it("counts the edits flagged risky", () => {
    const pass = reviewPassOf([
      waiting("a", "host", {
        join_risk: { verdict: "review", label: "risky" },
      }),
      waiting("b", "host", {
        join_risk: { verdict: "review", label: "join_review" },
      }),
    ]);
    expect(pass.riskyCount).toBe(1);
  });

  it("is empty when nothing waits", () => {
    expect(reviewPassOf([])).toEqual({ ids: [], trackCount: 0, riskyCount: 0 });
  });
});

describe("bulkReviewQuestion", () => {
  const pass = { ids: ["a", "b", "c"], trackCount: 2, riskyCount: 0 };

  it("names the count and tracks of an approval, and offers one Undo", () => {
    expect(bulkReviewQuestion("approve", pass)).toEqual({
      title: "Approve 3 pending edits?",
      message:
        "Their cuts go into the timeline on 2 tracks. One Undo takes them back.",
      keepLabel: "Keep reviewing",
      actionLabel: "Approve 3",
      danger: false,
    });
  });

  it("says what a rejection leaves alone, and marks it as discarding", () => {
    expect(bulkReviewQuestion("reject", pass)).toEqual({
      title: "Reject 3 pending edits?",
      message:
        "They leave the pending list on 2 tracks and the audio stays as it is. One Undo brings them back.",
      keepLabel: "Keep reviewing",
      actionLabel: "Reject 3",
      danger: true,
    });
  });

  it("uses the singular for one edit on one track", () => {
    const one = { ids: ["a"], trackCount: 1, riskyCount: 0 };
    expect(bulkReviewQuestion("approve", one).title).toBe(
      "Approve 1 pending edit?",
    );
    expect(bulkReviewQuestion("approve", one).message).toContain("1 track.");
    expect(bulkReviewQuestion("reject", one).actionLabel).toBe("Reject 1");
  });

  it.each([
    [1, " 1 is flagged risky."],
    [2, " 2 are flagged risky."],
  ])("warns when %i of an approval are risky", (riskyCount, sentence) => {
    expect(
      bulkReviewQuestion("approve", { ...pass, riskyCount }).message,
    ).toContain(sentence);
  });

  it("does not mention risk in a rejection", () => {
    expect(
      bulkReviewQuestion("reject", { ...pass, riskyCount: 2 }).message,
    ).not.toContain("risky");
  });
});

describe("pendingReviewFeedback", () => {
  it("announces completed approval with its exact history head", () => {
    const head = "abc" as import("../types/project").HistoryEntryId;
    expect(
      pendingReviewFeedback("approve", {
        queued: false,
        count: 2,
        historyHead: head,
        held: [],
      }),
    ).toEqual({
      message: "Approved 2 pending edits",
      undo: head,
    });
  });
});

describe("a Cut anyway that finishes an Approve all pass", () => {
  it("counts the whole pass", () => {
    expect(
      pendingReviewFeedback("approve", {
        queued: false,
        asked: false,
        count: 4,
        historyHead: "second" as HistoryEntryId,
        held: [],
        pass: { head: "first" as HistoryEntryId, applied: 6 },
      }),
    ).toEqual({
      message: "Approved 10 pending edits",
      undo: "second",
    });
  });
});

describe("bulkReviewDoneMessage", () => {
  it.each([
    ["approve", 1, "Approved 1 pending edit"],
    ["approve", 4, "Approved 4 pending edits"],
    ["reject", 2, "Rejected 2 pending edits"],
  ] as const)("%s %i", (action, count, message) => {
    expect(bulkReviewDoneMessage(action, count)).toBe(message);
  });
});
