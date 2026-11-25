import { applySuggestedActions, approveEdits } from "../api";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import {
  capturePendingReview,
  finishPendingReview,
} from "../utils/pendingReviewPass";
import { pendingAcceptRoute } from "./pendingDecision";

/**
 * The one executor behind every accept verb on a pending edit: the Action bar, the Edit Sheet
 * and Backspace. A cut approves the edit; every other route applies its suggested action in one
 * undo step, and a leave dismisses it without touching audio.
 */
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
  live.announceStatus(outcome.summary ?? "Applied the suggestion", {
    undo: outcome.historyHead,
  });
  if (live.selection === selection) live.setSelection(null);
  return { queued: false };
}
