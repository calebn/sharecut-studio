import type { ConfirmQuestion } from "../feedback/ask";
import type { PendingEditView } from "../types/project";

export type BulkReviewAction = "approve" | "reject";

export type ReviewPass = {
  ids: string[];
  trackCount: number;
  riskyCount: number;
};

export function reviewPassOf(edits: readonly PendingEditView[]): ReviewPass {
  const waiting = edits.filter((edit) => edit.review_required);
  const tracks = new Set(
    waiting.flatMap((edit) => edit.track_ids ?? [edit.track_id]),
  );
  return {
    ids: waiting.map((edit) => edit.id),
    trackCount: tracks.size,
    riskyCount: waiting.filter((edit) => edit.join_risk?.label === "risky")
      .length,
  };
}

function pendingEdits(n: number): string {
  return n === 1 ? "1 pending edit" : `${n} pending edits`;
}

function tracks(n: number): string {
  return n === 1 ? "1 track" : `${n} tracks`;
}

/** The question asked before a bulk review. It names the count so nobody confirms a number they did not see. */
export function bulkReviewQuestion(
  action: BulkReviewAction,
  pass: ReviewPass,
): Omit<ConfirmQuestion, "kind"> {
  const count = pass.ids.length;
  if (action === "reject") {
    return {
      title: `Reject ${pendingEdits(count)}?`,
      message: `They leave the pending list on ${tracks(pass.trackCount)} and the audio stays as it is. One Undo brings them back.`,
      keepLabel: "Keep reviewing",
      actionLabel: `Reject ${count}`,
      danger: true,
    };
  }
  const risky =
    pass.riskyCount === 0
      ? ""
      : pass.riskyCount === 1
        ? " 1 is flagged risky."
        : ` ${pass.riskyCount} are flagged risky.`;
  return {
    title: `Approve ${pendingEdits(count)}?`,
    message: `Their cuts go into the timeline on ${tracks(pass.trackCount)}.${risky} One Undo takes them back.`,
    keepLabel: "Keep reviewing",
    actionLabel: `Approve ${count}`,
    danger: false,
  };
}

export function bulkReviewDoneMessage(
  action: BulkReviewAction,
  count: number,
): string {
  return `${action === "approve" ? "Approved" : "Rejected"} ${pendingEdits(count)}`;
}
