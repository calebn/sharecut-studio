import { useSyncExternalStore } from "react";
import { runHistoryAction } from "../../commands/history";
import { executePointerCommand } from "../../commands/pointer";
import { canApplyPass12 } from "../../shareMode";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "../../state/documentSendOrder";
import { useDaw } from "../../state/useDaw";

export type HistoryAvailability = { canUndo: boolean; canRedo: boolean };

export function useHistoryControls() {
  const { projectPath, guestMode, shareCapabilities, canUndo, canRedo } =
    useDaw((state) => ({
      projectPath: state.projectPath,
      guestMode: state.guestMode,
      shareCapabilities: state.shareCapabilities,
      canUndo: state.project?.history.can_undo ?? false,
      canRedo: state.project?.history.can_redo ?? false,
    }));
  // A save or drain still running: a press waits for it and says so.
  const saving = useSyncExternalStore(subscribeDocumentActivity, () =>
    documentActivityBusy(projectPath),
  );
  const history = canApplyPass12(projectPath, guestMode, shareCapabilities)
    ? { canUndo, canRedo }
    : null;

  return {
    history,
    saving,
    onUndo: () => runHistoryAction("undo", executePointerCommand),
    onRedo: () => runHistoryAction("redo", executePointerCommand),
  };
}
