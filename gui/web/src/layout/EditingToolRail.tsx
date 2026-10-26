import { commandLabel } from "../commands/labels";
import { runPointerCommand } from "../commands/pointer";
import { canIngestMedia, canSuggestStructuralOnProject } from "../shareMode";
import { useZoomControls } from "../stage/edit/useZoomControls";
import { useHistoryControls } from "../stage/frame/useHistoryControls";
import { useDaw } from "../state/useDaw";
import { CommandButton } from "../ui/CommandButton";
import { Icon } from "../ui/Icon";
import { EditingToolRailView } from "./EditingToolRailView";
import { ToolModeToggle } from "./ToolModeToggle";

/** Ferrite-style bottom tool rail (phone/tablet). */
export function EditingToolRail({ inert = false }: { inert?: boolean }) {
  const {
    toolMode,
    commentMode,
    projectPath,
    guestMode,
    shareCapabilities,
    hasProject,
  } = useDaw((s) => ({
    toolMode: s.toolMode,
    commentMode: s.commentMode,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    hasProject: s.project != null,
  }));
  const { history, onUndo, onRedo } = useHistoryControls();
  const { zoom, onZoomIn, onZoomOut } = useZoomControls();
  const bladeAllowed = canSuggestStructuralOnProject(
    projectPath,
    guestMode,
    shareCapabilities,
    hasProject,
  );
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);

  return (
    <EditingToolRailView
      inert={inert}
      bladeAllowed={bladeAllowed}
      mayIngest={mayIngest}
      toolMode={toolMode}
      commentMode={commentMode}
      toolToggle={
        <>
          <ToolModeToggle compact />
          <CommandButton
            commandId="range.arm"
            className="editing-tool-rail-range"
            aria-label={commandLabel("range.arm", "short")}
          >
            <Icon
              name="range"
              size={20}
              className="editing-tool-rail-range-icon"
            />
            <span className="editing-tool-rail-range-label">
              {commandLabel("range.arm", "short")}
            </span>
          </CommandButton>
        </>
      }
      history={history}
      onUndo={onUndo}
      onRedo={onRedo}
      zoom={zoom}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onAddTrack={() => runPointerCommand("track.add")}
      onImport={() => runPointerCommand("media.import")}
      onCutAtPlayhead={() => runPointerCommand("edit.bladeCut")}
    />
  );
}
