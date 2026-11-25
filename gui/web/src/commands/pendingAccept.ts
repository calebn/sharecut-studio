import { applySuggestedActions, approveEdits } from "../api";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import {
  capturePendingReview,
  finishPendingReview,
} from "../utils/pendingReviewPass";
import { pendingAcceptRoute } from "./pendingDecision";

export async function acceptPending(
  projectPath: string,
  edit: PendingEditView,
): Promise<{ queued: boolean }> {
  if (pendingAcceptRoute(edit) === "cut") {
    const capture = capturePendingReview("approve", projectPath, edit);
    const outcome = await approveEdits(projectPath, [edit.id], false, true);
    finishPendingReview(capture, outcome);
    return { queued: outcome.queued };
  }
  const { projectEpoch, selection } = useDawStore.getState();
  const outcome = await applySuggestedActions(projectPath, [edit.id]);
  const live = useDawStore.getState();
  if (live.projectPath !== projectPath || live.projectEpoch !== projectEpoch)
    return { queued: outcome.queued };
  if (outcome.queued) {
    live.announceStatus("Saved. It sends when you reconnect.");
    return { queued: true };
  }
  if (outcome.appliedCount === 0) {
    // Already handled elsewhere: its history head is not this action's, so no Undo.
    live.announceStatus("Nothing was applied");
    const stillPending = live.project?.pending_edits.some(
      (item) => item.id === edit.id,
    );
    if (!stillPending && live.selection === selection) live.setSelection(null);
    return { queued: false };
  }
  live.announceStatus(outcome.summary ?? "Applied the suggestion", {
    undo: outcome.historyHead,
  });
  if (live.selection === selection) live.setSelection(null);
  return { queued: false };
}
