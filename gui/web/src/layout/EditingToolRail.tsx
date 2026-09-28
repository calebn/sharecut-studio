import { runPointerCommand } from "../commands/pointer";
import { useBladeCut } from "../hooks/useBladeCut";
import { canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { EditingToolRailView } from "./EditingToolRailView";
import { ToolModeToggle } from "./ToolModeToggle";

/** Ferrite-style bottom tool rail + blade confirm sheet (phone/tablet). */
export function EditingToolRail() {
  const { toolMode, commentMode, projectPath, guestMode, shareCapabilities } =
    useDaw((s) => ({
      toolMode: s.toolMode,
      commentMode: s.commentMode,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    }));
  const { allowed, busy, error, bladeConfirmSec, trackIdsForCut } =
    useBladeCut();
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);

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
      toolToggle={<ToolModeToggle compact />}
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
