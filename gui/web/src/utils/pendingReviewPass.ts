import {
  activateDocumentScope,
  type DocumentScope,
  isCurrentDocumentScope,
} from "../document/authorityState";
import type { ConfirmQuestion } from "../feedback/ask";
import { canReviewPendingEdit } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type {
  HistoryEntryId,
  PendingEditView,
  Selection,
} from "../types/project";
import { PENDING_REVIEW_QUEUED_MESSAGE } from "./pendingEditLabels";

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

export type ReviewOutcome = Readonly<
  | { queued: true; asked: false; count: null; historyHead: null }
  | { queued: false; asked: true; count: null; historyHead: null }
  | {
      queued: false;
      asked: false;
      count: number;
      historyHead: HistoryEntryId | null;
    }
>;

export type PendingReviewCapture = Readonly<{
  action: BulkReviewAction;
  projectPath: string;
  projectEpoch: number;
  scope: DocumentScope;
  selected: Readonly<{
    selection: Selection;
    edit: Pick<PendingEditView, "id" | "track_id" | "type" | "timebase">;
  }> | null;
}>;

export function capturePendingReview(
  action: BulkReviewAction,
  projectPath: string,
  edit?: PendingEditView,
): PendingReviewCapture {
  const state = useDawStore.getState();
  return {
    action,
    projectPath,
    projectEpoch: state.projectEpoch,
    scope: activateDocumentScope(projectPath),
    selected: edit
      ? {
          selection: state.selection,
          edit: {
            id: edit.id,
            track_id: edit.track_id,
            type: edit.type,
            timebase: edit.timebase,
          },
        }
      : null,
  };
}

function currentPendingReview(
  capture: PendingReviewCapture,
  beforeSend: boolean,
): boolean {
  const state = useDawStore.getState();
  if (
    state.projectPath !== capture.projectPath ||
    state.projectEpoch !== capture.projectEpoch ||
    !isCurrentDocumentScope(capture.scope)
  )
    return false;
  if (
    beforeSend &&
    !canReviewPendingEdit(state.projectPath, state.shareCapabilities)
  )
    return false;
  if (!capture.selected) return true;
  if (state.selection !== capture.selected.selection) return false;
  const expected = capture.selected.edit;
  const edit = state.project?.pending_edits.find(
    (item) => item.id === expected.id,
  );
  return edit
    ? edit.applied === false &&
        edit.track_id === expected.track_id &&
        edit.type === expected.type &&
        (edit.timebase ?? "source") === (expected.timebase ?? "source")
    : !beforeSend;
}

export function requireCurrentPendingReview(
  capture: PendingReviewCapture,
): void {
  if (!currentPendingReview(capture, true))
    throw new Error(
      "This pending review changed. Select it again to review it.",
    );
}

export function pendingReviewFeedback(
  action: BulkReviewAction,
  outcome: ReviewOutcome,
): { message: string; undo: HistoryEntryId | null } | null {
  if (outcome.asked) return null;
  if (outcome.queued)
    return { message: PENDING_REVIEW_QUEUED_MESSAGE, undo: null };
  return outcome.count === 0
    ? {
        message:
          action === "approve"
            ? "No pending edits were approved"
            : "No pending edits were rejected",
        undo: null,
      }
    : {
        message: bulkReviewDoneMessage(action, outcome.count),
        undo: outcome.historyHead,
      };
}

export function finishPendingReview(
  capture: PendingReviewCapture,
  outcome: ReviewOutcome,
): void {
  if (!currentPendingReview(capture, false)) return;
  const feedback = pendingReviewFeedback(capture.action, outcome);
  if (!feedback) return;
  const state = useDawStore.getState();
  state.announceStatus(feedback.message, { undo: feedback.undo });
  const selected = capture.selected;
  const after = useDawStore.getState();
  if (
    !outcome.queued &&
    selected &&
    after.selection === selected.selection &&
    !after.project?.pending_edits.some((edit) => edit.id === selected.edit.id)
  )
    after.setSelection(null);
}
