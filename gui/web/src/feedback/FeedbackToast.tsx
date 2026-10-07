import { useEffect, useRef, useState } from "react";
import { executePointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { HistoryEntryId } from "../types/project";
import { Toast } from "../ui";
import { errorMessage } from "../utils/apiError";
import { usePhoneToastDock } from "./toastDock";

/**
 * The visible twin of `announceStatus`. The shell's polite live region already
 * speaks the same string, so this toast does not announce. Undo names the
 * history entry the change recorded and shows only while that entry is the
 * head this tab sees; the server refuses the undo (`history_stale`) if another
 * edit landed first, so Undo never reverses someone else's change.
 */
export function FeedbackToast() {
  const { toast, headId } = useDaw((s) => ({
    toast: s.feedbackToast,
    headId: s.project?.history?.head_id ?? null,
  }));
  const [undoing, setUndoing] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);
  usePhoneToastDock(regionRef, toast != null);
  const undoEntry =
    toast?.undo != null && toast.undo === headId ? toast.undo : null;

  useEffect(() => {
    if (toast?.undo && undoEntry == null) {
      useDawStore.getState().dropFeedbackUndo(toast.id);
    }
  }, [toast, undoEntry]);

  const undo = async (message: string, expectedHeadId: HistoryEntryId) => {
    setUndoing(true);
    try {
      const result = await executePointerCommand("history.undo", {
        expectedHeadId,
      });
      if (result.status === "ok") {
        useDawStore.getState().announceStatus(`Undone: ${message}`);
      }
    } catch (e) {
      useDawStore.getState().announceStatus(`Undo failed: ${errorMessage(e)}`);
    } finally {
      setUndoing(false);
    }
  };

  return (
    <Toast
      announce={false}
      className="ui-toast-region--app"
      regionRef={regionRef}
      toast={toast}
      onDismiss={() => {
        if (toast) useDawStore.getState().dismissFeedbackToast(toast.id);
      }}
      onUndo={
        toast && undoEntry
          ? () => void undo(toast.message, undoEntry)
          : undefined
      }
      undoDisabled={undoing}
    />
  );
}
