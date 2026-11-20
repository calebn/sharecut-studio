import { runHistoryAction } from "../../commands/history";
import { historyAvailability } from "../../commands/historyAvailability";
import { executePointerCommand } from "../../commands/pointer";
import { canApplyPass12 } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { useDocumentBusy } from "../../state/useDocumentBusy";

export type HistoryAvailability = {
  canUndo: boolean;
  canRedo: boolean;
  undoReason?: string;
  redoReason?: string;
};

export function useHistoryControls() {
  const { projectPath, guestMode, shareCapabilities, project } = useDaw(
    (state) => ({
      projectPath: state.projectPath,
      guestMode: state.guestMode,
      shareCapabilities: state.shareCapabilities,
      project: state.project,
    }),
  );
  // A save or drain still running: a press waits for it and says so.
  const saving = useDocumentBusy(projectPath);
  const shown = historyAvailability({
    project,
    projectPath,
    guestMode,
    shareCapabilities,
  });
  const history = canApplyPass12(projectPath, guestMode, shareCapabilities)
    ? {
        canUndo: shown.undo.ok,
        canRedo: shown.redo.ok,
        undoReason: shown.undo.ok ? undefined : shown.undo.reason,
        redoReason: shown.redo.ok ? undefined : shown.redo.reason,
      }
    : null;

  return {
    history,
    saving,
    onUndo: () => runHistoryAction("undo", executePointerCommand),
    onRedo: () => runHistoryAction("redo", executePointerCommand),
  };
}
