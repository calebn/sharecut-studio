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
  outcome?: Pick<ReviewOutcome, "held">,
): string {
  const held = outcome?.held ?? [];
  if (action === "approve" && held.length > 0)
    return bulkReviewHeldMessage(count, held);
  return `${action === "approve" ? "Approved" : "Rejected"} ${pendingEdits(count)}`;
}

/** A cut Approve all left pending, with the reason the list shows. */
export type HeldCut = Readonly<{ id: string; label: string; reason: string }>;

export type ReviewOutcome = Readonly<
  | { queued: true; count: null; historyHead: null; held?: readonly HeldCut[] }
  | {
      queued: false;
      count: number;
      historyHead: HistoryEntryId | null;
      held?: readonly HeldCut[];
    }
>;

/** "Applied 80, held 6" with the first two held cuts named; the rest stay in the list. */
export function bulkReviewHeldMessage(
  count: number,
  held: readonly HeldCut[],
): string {
  const named = held
    .slice(0, 2)
    .map((h) => `${h.label} is held: ${h.reason}.`)
    .join(" ");
  const more =
    held.length > 2 ? ` ${held.length - 2} more are held in the list.` : "";
  return `Applied ${count}, held ${held.length}. ${named}${more}`;
}

export type PendingReviewCapture = Readonly<{
  action: BulkReviewAction;
  projectPath: string;
  projectEpoch: number;
  scope: DocumentScope;
  /** A selected capture belongs to a review request containing only this edit. */
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

export function pendingReviewFeedback(
  action: BulkReviewAction,
  outcome: ReviewOutcome,
): { message: string; undo: HistoryEntryId | null } | null {
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
        message: bulkReviewDoneMessage(action, outcome.count, outcome),
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
    (outcome.count > 0 ||
      !after.project?.pending_edits.some(
        (edit) => edit.id === selected.edit.id,
      ))
  )
    after.setSelection(null);
}
