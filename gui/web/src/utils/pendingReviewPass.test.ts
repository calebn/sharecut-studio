import { beforeEach, describe, expect, it } from "vitest";
import { applyDocumentResult } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { minimalProject, pendingEditView } from "../test/fixtures";
import {
  bulkReviewDoneMessage,
  bulkReviewQuestion,
  capturePendingReview,
  finishPendingReview,
  pendingReviewFeedback,
  type ReviewOutcome,
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

describe("pending review selection ownership", () => {
  const path = "/tmp/review.json";
  const edit = waiting("reviewed", "host");
  const selection = { kind: "pending" as const, id: edit.id, trackId: "host" };
  const completed = { queued: false, count: 1, historyHead: null } as const;

  beforeEach(() => {
    resetDocumentAuthority();
    useDawStore
      .getState()
      .hydrate(path, minimalProject({ pending_edits: [edit] }));
    activateDocumentScope(path);
    useDawStore.getState().setSelection(selection);
    useDawStore.setState({ feedbackToast: null, statusAnnouncement: "" });
  });

  function adoptEmpty() {
    applyDocumentResult(
      {
        snapshot: {
          server_seq: 1,
          project: minimalProject({ pending_edits: [] }),
        },
      },
      activateDocumentScope(path),
    );
  }

  it.each<ReviewOutcome>([
    { queued: false, count: 0, historyHead: null },
    { queued: true, count: null, historyHead: null },
  ])(
    "retains selection through later adoption for queued=$queued and count=$count",
    (outcome) => {
      const capture = capturePendingReview("approve", path, edit);
      finishPendingReview(capture, outcome);
      expect(useDawStore.getState().selection).toBe(selection);
      adoptEmpty();
      expect(useDawStore.getState().project?.pending_edits).toEqual([]);
      expect(useDawStore.getState().selection).toBe(selection);
    },
  );

  it("does not give bulk completion ownership of the selected edit", () => {
    const capture = capturePendingReview("approve", path);
    adoptEmpty();
    finishPendingReview(capture, completed);
    expect(useDawStore.getState().selection).toBe(selection);
  });

  it.each(["selection", "path", "epoch", "scope", "edit"] as const)(
    "ignores completion after the captured %s changes",
    (change) => {
      const capture = capturePendingReview("approve", path, edit);
      const state = useDawStore.getState();
      if (change === "selection") state.setSelection({ ...selection });
      if (change === "path")
        useDawStore.setState({ projectPath: "/tmp/other.json" });
      if (change === "epoch")
        useDawStore.setState({ projectEpoch: state.projectEpoch + 1 });
      if (change === "scope") resetDocumentAuthority();
      if (change === "edit")
        useDawStore.setState({
          project: minimalProject({
            pending_edits: [{ ...edit, type: "mute" }],
          }),
        });
      const currentSelection = useDawStore.getState().selection;
      finishPendingReview(capture, completed);
      expect(useDawStore.getState().selection).toBe(currentSelection);
      expect(useDawStore.getState().feedbackToast).toBeNull();
    },
  );
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

describe("bulkReviewDoneMessage", () => {
  it.each([
    ["approve", 1, "Approved 1 pending edit"],
    ["approve", 4, "Approved 4 pending edits"],
    ["reject", 2, "Rejected 2 pending edits"],
  ] as const)("%s %i", (action, count, message) => {
    expect(bulkReviewDoneMessage(action, count)).toBe(message);
  });
});
