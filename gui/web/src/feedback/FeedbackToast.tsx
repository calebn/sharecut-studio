import { useEffect, useState } from "react";
import { executePointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { Toast } from "../ui";
import { errorMessage } from "../utils/apiError";

/**
 * The visible twin of `announceStatus`. The shell's polite live region already
 * speaks the same string, so this toast does not announce. Undo runs
 * `history.undo` through the command bus, and only while history still sits on
 * the change the toast names; once anything else moves history, Undo goes away.
 */
export function FeedbackToast() {
  const { toast, cursor } = useDaw((s) => ({
    toast: s.feedbackToast,
    cursor: s.project?.history?.cursor ?? null,
  }));
  const [undoing, setUndoing] = useState(false);
  const undoValid = toast?.undo != null && toast.undo.cursor === cursor;

  useEffect(() => {
    if (toast?.undo && !undoValid) {
      useDawStore.getState().dropFeedbackUndo(toast.id);
    }
  }, [toast, undoValid]);

  const undo = async (message: string) => {
    setUndoing(true);
    try {
      const result = await executePointerCommand("history.undo");
      const s = useDawStore.getState();
      if (result.status === "ok") {
        s.announceStatus(`Undone: ${message}`);
      } else if (result.status === "disabled") {
        s.announceStatus(`Undo failed: ${result.reason}`);
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
      toast={toast}
      onDismiss={() => {
        if (toast) useDawStore.getState().dismissFeedbackToast(toast.id);
      }}
      onUndo={toast && undoValid ? () => void undo(toast.message) : undefined}
      undoDisabled={undoing}
    />
  );
}
