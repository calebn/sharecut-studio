import { execute } from "../commands/execute";
import { useBladeCut } from "../hooks/useBladeCut";
import { canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { EditingToolRailView } from "./EditingToolRailView";
import { ToolModeToggle } from "./ToolModeToggle";

function runPointer(id: string): void {
  void execute(id, {}, { skipWhen: true });
}

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
      onAddTrack={() => runPointer("track.add")}
      onImport={() => runPointer("media.import")}
      onCutAtPlayhead={() => runPointer("edit.bladeCut")}
      onCancelCut={() => runPointer("edit.bladeCut.cancel")}
      onConfirmCut={() => {
        runPointer("edit.bladeCut.confirm");
        runPointer("tool.blade");
      }}
    />
  );
}
