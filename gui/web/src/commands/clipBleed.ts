import { restoreClipBleed } from "../api/clipBleed";
import { isCurrentDocumentScope } from "../document/authorityState";
import {
  type ClipBleedUndoReceipt,
  clipBleedSession,
} from "../edit/clipBleedSession";
import { getClipPlacement } from "../edit/clipPlacement";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { ApiError, errorMessage } from "../utils/apiError";
import { registerCommand } from "./execute";
import { executePointerCommand } from "./pointer";
import { enqueueTrackMutate } from "./trackMutation";
import type { ExecuteResult } from "./types";

const STALE_MESSAGE =
  "This region changed. Refresh regions and select it again.";

function accessReason(): string | undefined {
  const state = useDawStore.getState();
  if (isShareProjectKey(state.projectPath) || state.guestMode !== null)
    return "Only the project host can restore this audio.";
  if (!state.project || !state.projectPath) return "Open a project first.";
  return undefined;
}

export function clipBleedDisabledReason(): string | undefined {
  const access = accessReason();
  if (access) return access;
  const state = useDawStore.getState();
  const action = clipBleedSession.getSnapshot()?.action.state;
  if (action === "saving") return "Saving Restore choice…";
  if (action === "undoing") return "Undoing Restore choice…";
  if (state.heldTrim !== null)
    return "Finish or cancel the trim before restoring audio.";
  if (state.joinMutationInFlight) return "Wait for the join change to finish.";
  if (state.rangeBusy) return "Wait for the range edit to finish.";
  if (state.timelineDragging) return "Finish the drag before restoring audio.";
  if (getClipPlacement().kind !== "idle")
    return "Apply or cancel Move clip before restoring audio.";
  return undefined;
}

function selectedOccurrence(
  trackId: string,
  clipId: string,
  regionKey?: string | null,
): boolean {
  const selection = useDawStore.getState().selection;
  return (
    selection?.kind === "bleedAttenuation" &&
    selection.id === clipId &&
    selection.trackId === trackId &&
    (regionKey === undefined || selection.regionKey === regionKey)
  );
}

export function registerClipBleedCommands(): void {
  registerCommand("edit.restoreClipBleed", () => {
    const reason = clipBleedDisabledReason();
    if (reason) return { status: "disabled", reason };
    const captured = clipBleedSession.currentTarget();
    const regionKey = clipBleedSession.getSnapshot()?.selectedKey;
    if (
      !captured ||
      !regionKey ||
      !selectedOccurrence(captured.trackId, captured.clipId, regionKey)
    )
      return { status: "disabled", reason: STALE_MESSAGE };

    return enqueueTrackMutate(async (): Promise<ExecuteResult> => {
      const blocked = clipBleedDisabledReason();
      if (blocked) return { status: "disabled", reason: blocked };
      if (
        !isCurrentDocumentScope(captured.scope) ||
        useDawStore.getState().projectEpoch !== captured.projectEpoch ||
        !selectedOccurrence(captured.trackId, captured.clipId, regionKey) ||
        !clipBleedSession.currentTarget(captured)
      )
        return { status: "disabled", reason: STALE_MESSAGE };
      const ticket = clipBleedSession.beginRestore(captured);
      if (!ticket) return { status: "disabled", reason: STALE_MESSAGE };
      try {
        const outcome = await restoreClipBleed(
          captured.scope.path,
          captured.target,
        );
        if (!clipBleedSession.finishRestore(ticket, outcome))
          return { status: "disabled", reason: STALE_MESSAGE };
        const receipt = clipBleedSession.getSnapshot()?.undo;
        if (outcome.status === "acknowledged" && receipt) {
          useDawStore.getState().announceStatus("Restore choice saved", {
            undo: receipt.expectedHeadId,
          });
          return { status: "ok" };
        }
        const message =
          outcome.status === "queued"
            ? "Restore is waiting to save. Refresh regions after the save finishes."
            : outcome.status === "noop"
              ? "No Restore choice changed. Refresh regions to check the saved choice."
              : "Restore could not be confirmed. Refresh regions to check the saved choice.";
        useDawStore
          .getState()
          .announceStatus(
            message,
            outcome.status === "queued" ? undefined : { tone: "error" },
          );
        return { status: "disabled", reason: message };
      } catch (error) {
        const stale =
          error instanceof ApiError && error.code === "bleed_restore_changed";
        const message = stale ? STALE_MESSAGE : errorMessage(error);
        clipBleedSession.failAction(ticket, {
          state: "error",
          code: stale ? "STALE_TARGET" : "failed",
          message,
        });
        return { status: "disabled", reason: message };
      }
    });
  });
}

export async function undoClipBleed(
  receipt: ClipBleedUndoReceipt,
): Promise<ExecuteResult> {
  const reason = accessReason();
  if (reason) return { status: "disabled", reason };
  if (
    !selectedOccurrence(receipt.trackId, receipt.clipId) ||
    !clipBleedSession.currentUndo(receipt)
  )
    return { status: "disabled", reason: STALE_MESSAGE };
  const ticket = clipBleedSession.beginUndo(receipt);
  if (!ticket) return { status: "disabled", reason: STALE_MESSAGE };
  try {
    const result = await executePointerCommand("history.undo", {
      expectedHeadId: receipt.expectedHeadId,
    });
    if (result.status === "ok") {
      if (!clipBleedSession.finishUndo(ticket))
        return { status: "disabled", reason: STALE_MESSAGE };
      useDawStore.getState().announceStatus("Restore choice undone");
    } else {
      clipBleedSession.failAction(ticket, {
        state: "error",
        code: "failed",
        message:
          result.status === "disabled"
            ? result.reason
            : "Undo is unavailable. Inspect History before trying again.",
      });
    }
    return result;
  } catch (error) {
    const message = errorMessage(error);
    clipBleedSession.failAction(ticket, {
      state: "error",
      code: "failed",
      message,
    });
    return { status: "disabled", reason: message };
  }
}
