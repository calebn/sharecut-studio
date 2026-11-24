import { useCallback } from "react";
import { updatePendingEdit } from "../api";
import { decideSelectedPending } from "../commands/editVerbs";
import {
  canRetimePendingEdit,
  canReviewPendingEdit,
  canSuggestStructural,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { ApiError, TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";
import { EMPTY_OBJ } from "../utils/empty";
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
    if (
      state.projectPath !== capturedPath ||
      state.projectEpoch !== capturedEpoch ||
      state.selection?.kind !== "pending" ||
      state.selection.id !== editId
    ) {
      throw new Error("That suggestion is no longer selected.");
    }
    const result = await decideSelectedPending(action);
    if (result.status === "disabled") {
      if (useDawStore.getState().pendingRefineGate === editId)
        throw new ApiError(result.reason, TRANSCRIPT_REFINE_REQUIRED_CODE);
      if (!result.told) throw new Error(result.reason);
    }
    return { queued: result.status === "ok" && result.queued === true };
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
