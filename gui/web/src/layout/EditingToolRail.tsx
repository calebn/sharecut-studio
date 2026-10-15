import { runPointerCommand } from "../commands/pointer";
import { useBladeCut } from "../hooks/useBladeCut";
import { canIngestMedia } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { CommandButton, Icon } from "../ui";
import { EditingToolRailView } from "./EditingToolRailView";
import { ToolModeToggle } from "./ToolModeToggle";
import { useHistoryControls } from "./useHistoryControls";
import { useZoomControls } from "./useZoomControls";

/** Ferrite-style bottom tool rail + blade confirm sheet (phone/tablet). */
export function EditingToolRail({ inert = false }: { inert?: boolean }) {
  const { toolMode, commentMode, projectPath, guestMode, shareCapabilities } =
    useDaw((s) => ({
      toolMode: s.toolMode,
      commentMode: s.commentMode,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    }));
  const { history, onUndo, onRedo } = useHistoryControls();
  const { zoom, onZoomIn, onZoomOut } = useZoomControls();
  const { allowed, busy, error, bladeConfirmSec, trackIdsForCut } =
    useBladeCut();
  const mayIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);

  return (
    <EditingToolRailView
      inert={inert}
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
          <CommandButton
            commandId="range.arm"
            className="editing-tool-rail-range"
            aria-label="Select range"
          >
            <Icon
              name="range"
              size={20}
              className="editing-tool-rail-range-icon"
            />
            <span className="editing-tool-rail-range-label">Select range</span>
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
      onCancelCut={() => runPointerCommand("edit.bladeCut.cancel")}
      onConfirmCut={() => {
        runPointerCommand("edit.bladeCut.confirm");
        runPointerCommand("tool.blade");
      }}
    />
  );
}
