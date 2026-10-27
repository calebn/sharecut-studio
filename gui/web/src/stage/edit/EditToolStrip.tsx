import { commandLabel } from "../../commands/labels";
import { runPointerCommand } from "../../commands/pointer";
import { canSuggestStructuralOnProject } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { EditToolStripView } from "./EditToolStripView";
import { ToolModeToggle } from "./ToolModeToggle";

/** The timeline corner's tools: existing commands only, no new behaviour. */
export function EditToolStrip() {
  const {
    toolMode,
    commentMode,
    rangeArmed,
    hasProject,
    projectPath,
    guestMode,
    shareCapabilities,
  } = useDaw((s) => ({
    toolMode: s.toolMode,
    commentMode: s.commentMode,
    rangeArmed: s.rangeArmed,
    hasProject: s.project != null,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const bladeAllowed = canSuggestStructuralOnProject(
    projectPath,
    guestMode,
    shareCapabilities,
    hasProject,
  );
  return (
    <EditToolStripView
      toolToggle={<ToolModeToggle bladeAllowed={bladeAllowed} />}
      rangeArmed={rangeArmed}
      rangeReason={hasProject ? undefined : "Open a project to select a range"}
      rangeTitle={commandLabel("range.arm")}
      onToggleRange={() => runPointerCommand("range.arm")}
      showCut={bladeAllowed && toolMode === "blade" && !commentMode}
      cutTitle="Cut selected tracks at playhead"
      onCut={() => runPointerCommand("edit.bladeCut")}
    />
  );
}
