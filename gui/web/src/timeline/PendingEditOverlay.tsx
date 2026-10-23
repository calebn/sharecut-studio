import { useCallback } from "react";
import { approveEdits, rejectEdits, updatePendingEdit } from "../api";
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
