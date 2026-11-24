import { useCallback } from "react";
import { updatePendingEdit } from "../api";
import { canRetimePendingEdit, canSuggestStructural } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { EMPTY_OBJ } from "../utils/empty";
import {
  PendingEditOverlayView,
  type PendingEditOverlayViewProps,
} from "./PendingEditOverlayView";

type PendingEditOverlayProps = Omit<
  PendingEditOverlayViewProps,
  "clipsByTrack" | "projectPath" | "canAdjust" | "onCommitSpan"
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
        undefined,
        undefined,
        // A refused drag says so on the status line and snaps back; a Needs attention row would replace that sentence.
        { refusalInline: true },
      );
    },
    [],
  );
  return (
    <PendingEditOverlayView
      {...props}
      projectPath={projectPath}
      clipsByTrack={clipsByTrack}
      canAdjust={canAdjust}
      onCommitSpan={onCommitSpan}
    />
  );
}
