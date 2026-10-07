import { runHistoryAction } from "../commands/history";
import { executePointerCommand, runPointerCommand } from "../commands/pointer";
import { useBladeCut } from "../hooks/useBladeCut";
import { canApplyPass12, canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { CommandButton } from "../ui/CommandButton";
import { EditingToolRailView } from "./EditingToolRailView";
import { ToolModeToggle } from "./ToolModeToggle";

/** Ferrite-style bottom tool rail + blade confirm sheet (phone/tablet). */
export function EditingToolRail() {
  const {
    toolMode,
    commentMode,
    projectPath,
    guestMode,
    shareCapabilities,
    canUndo,
    canRedo,
  } = useDaw((s) => ({
    toolMode: s.toolMode,
    commentMode: s.commentMode,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    canUndo: s.project?.history.can_undo ?? false,
    canRedo: s.project?.history.can_redo ?? false,
  }));
  const { allowed, busy, error, bladeConfirmSec, trackIdsForCut } =
    useBladeCut();
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mayEdit = canApplyPass12(projectPath, guestMode, shareCapabilities);

  return (
    <EditingToolRailView
      bladeAllowed={allowed}
      mayIngest={mayIngest}
      toolMode={toolMode}
      commentMode={commentMode}
      busy={busy}
      error={error}
      bladeConfirmSec={bladeConfirmSec}
      trackIdsForCut={trackIdsForCut}
      toolToggle={
        <>
          <ToolModeToggle compact />
          <CommandButton commandId="range.arm">Select range</CommandButton>
        </>
      }
      history={mayEdit ? { canUndo, canRedo } : null}
      onUndo={() => runHistoryAction("undo", executePointerCommand)}
      onRedo={() => runHistoryAction("redo", executePointerCommand)}
      onAddTrack={() => runPointerCommand("track.add")}
      onImport={() => runPointerCommand("media.import")}
      onCutAtPlayhead={() => runPointerCommand("edit.bladeCut")}
      onCancelCut={() => runPointerCommand("edit.bladeCut.cancel")}
      onConfirmCut={() => {
        runPointerCommand("edit.bladeCut.confirm");
        runPointerCommand("tool.blade");
      }}
    />
  );
}
