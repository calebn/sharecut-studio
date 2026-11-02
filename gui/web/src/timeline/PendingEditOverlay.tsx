import { useCallback } from "react";
import { approveEdits, rejectEdits, updatePendingEdit } from "../api";
import { applyPendingSuggestion } from "../commands/editVerbs";
import {
  decideThroughSheet,
  pendingOffersCut,
  sheetBusyReason,
} from "../commands/pendingDecision";
import {
  canRetimePendingEdit,
  canReviewPendingEdit,
  canSuggestStructural,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { EMPTY_OBJ } from "../utils/empty";
import {
  capturePendingReview,
  finishPendingReview,
} from "../utils/pendingReviewPass";
import {
  PendingEditOverlayView,
  type PendingEditOverlayViewProps,
} from "./PendingEditOverlayView";

type PendingEditOverlayProps = Omit<
  PendingEditOverlayViewProps,
  | "clipsByTrack"
  | "projectPath"
  | "canAdjust"
  | "canApply"
  | "onCommitSpan"
  | "onReviewAction"
>;

export function PendingEditOverlay(props: PendingEditOverlayProps) {
  const { projectPath, guestMode, shareCapabilities } = useDaw((state) => ({
    projectPath: state.projectPath,
    guestMode: state.guestMode,
    shareCapabilities: state.shareCapabilities,
  }));
  const clipsByTrack = useDawStore(
    (state) => state.project?.clips.tracks ?? EMPTY_OBJ,
  );
  const canAdjust = canSuggestStructural(
    projectPath,
    guestMode,
    shareCapabilities,
  );
  const canApply = canReviewPendingEdit(projectPath, shareCapabilities);
  const onCommitSpan = useCallback<PendingEditOverlayViewProps["onCommitSpan"]>(
    async (
      capturedPath,
      capturedEpoch,
      editId,
      expectedSourceStart,
      expectedSourceEnd,
      sourceStart,
      sourceEnd,
    ) => {
      const state = useDawStore.getState();
      const current = state.project?.pending_edits.find(
        (edit) => edit.id === editId,
      );
      if (
        state.projectPath !== capturedPath ||
        state.projectEpoch !== capturedEpoch ||
        !current ||
        !canRetimePendingEdit(
          state.projectPath,
          state.shareCapabilities,
          state.shareAuthor,
          current.author,
        ) ||
        current.exact_range ||
        current.source_start !== expectedSourceStart ||
        current.source_end !== expectedSourceEnd
      ) {
        return;
      }
      await updatePendingEdit(
        capturedPath,
        editId,
        sourceStart,
        sourceEnd,
        false,
      );
    },
    [],
  );
  const onReviewAction = useCallback<
    PendingEditOverlayViewProps["onReviewAction"]
  >(async (capturedPath, capturedEpoch, editId, action) => {
    const state = useDawStore.getState();
    const current = state.project?.pending_edits.find(
      (item) => item.id === editId,
    );
    if (
      !current ||
      state.projectPath !== capturedPath ||
      state.projectEpoch !== capturedEpoch ||
      state.selection?.kind !== "pending" ||
      state.selection.id !== editId ||
      !canReviewPendingEdit(state.projectPath, state.shareCapabilities)
    ) {
      throw new Error(
        "You do not have permission to review this pending edit.",
      );
    }
    if (pendingOffersCut(current)) {
      // Cut and Keep here are the Action bar's. A shorten or lower Cut applies the suggestion's own
      // action (approving would cut it whole); the rest go through the open sheet when it shows
      // this edit, so its busy gate, Still sending notice and refine recovery apply once.
      if (action === "approve" && current.suggested_action !== "cut") {
        const busy = sheetBusyReason(editId);
        if (busy) throw new Error(busy);
        // A failure is announced in the status line by the apply itself; it is not thrown again.
        await applyPendingSuggestion();
        return { queued: false };
      }
      const sheet = await decideThroughSheet(editId, action);
      if (sheet) {
        if (sheet.status === "disabled") throw new Error(sheet.reason);
        return { queued: false };
      }
    }
    const capture = capturePendingReview(action, capturedPath, current);
    const result =
      action === "approve"
        ? approveEdits(capturedPath, [editId], false, true)
        : rejectEdits(capturedPath, [editId]);
    const outcome = await result;
    if (!outcome.queued) finishPendingReview(capture, outcome);
    return outcome;
  }, []);
  return (
    <PendingEditOverlayView
      {...props}
      projectPath={projectPath}
      clipsByTrack={clipsByTrack}
      canAdjust={canAdjust}
      canApply={canApply}
      onCommitSpan={onCommitSpan}
      onReviewAction={onReviewAction}
    />
  );
}
