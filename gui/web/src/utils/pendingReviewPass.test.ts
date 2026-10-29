import { beforeEach, describe, expect, it } from "vitest";
import { applyDocumentResult } from "../document/applyDocumentUpdate";
import {
  activateDocumentScope,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { minimalProject, pendingEditView } from "../test/fixtures";
import {
  capturePendingReview,
  finishPendingReview,
  heldReasonText,
  pendingReviewFeedback,
  type ReviewOutcome,
} from "./pendingReviewPass";

const waiting = (id: string, track: string, extra = {}) =>
  pendingEditView({
    id,
    track_id: track,
    track_ids: [track],
    review_required: true,
    ...extra,
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

describe("bulk done message", () => {
  it.each([
    ["approve", 1, "Approved 1 pending edit"],
    ["approve", 4, "Approved 4 pending edits"],
    ["reject", 2, "Rejected 2 pending edits"],
  ] as const)("%s %i", (action, count, message) => {
    expect(
      pendingReviewFeedback(action, {
        queued: false,
        count,
        historyHead: null,
      })?.message,
    ).toBe(message);
  });
});

describe("heldReasonText", () => {
  it("sends an unsure-word hold to the word check and passes other reasons through", () => {
    expect(heldReasonText("unsure_word")).toBe(
      "It has a word we're not sure of. Check the word first, then cut.",
    );
    expect(heldReasonText("other")).toBe("other");
  });
});
