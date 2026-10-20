import { type ReactNode } from "react";
import { commandLabel } from "../commands/labels";
import type { ToolMode } from "../state/types";
import { Button } from "../ui";
import { HistoryControls } from "./HistoryControls";
import type { HistoryAvailability } from "./useHistoryControls";
import { RailLabelPeek, useRailLabelPeek } from "./useRailLabelPeek";
import type { ZoomAvailability } from "./useZoomControls";
import { ZoomControls } from "./ZoomControls";

export interface EditingToolRailViewProps {
  inert?: boolean;
  bladeAllowed: boolean;
  mayIngest: boolean;
  toolMode: ToolMode;
  commentMode: boolean;
  toolToggle: ReactNode;
  /** Undo and Redo for people who can edit; null hides them. */
  history: HistoryAvailability | null;
  onUndo: () => void;
  onRedo: () => void;
  zoom: ZoomAvailability;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onAddTrack: () => void;
  onImport: () => void;
  onCutAtPlayhead: () => void;
}

/** Store-free Ferrite-style bottom tool rail (phone/tablet). */
export function EditingToolRailView({
  inert = false,
  bladeAllowed,
  mayIngest,
  toolMode,
  commentMode,
  toolToggle,
  history,
  onUndo,
  onRedo,
  zoom,
  onZoomIn,
  onZoomOut,
  onAddTrack,
  onImport,
  onCutAtPlayhead,
}: EditingToolRailViewProps) {
  const { handlers, peek } = useRailLabelPeek();
  return (
    <>
      <div
        className="editing-tool-rail"
        inert={inert}
        role="group"
        aria-label="Editing tools"
      >
        <div className="editing-tool-rail-tools" {...handlers}>
          {bladeAllowed ? toolToggle : null}
          {mayIngest ? (
            <>
              <Button
                className="editing-tool-rail-ingest"
                onClick={onAddTrack}
                title="Add empty track"
              >
                + Track
              </Button>
              <Button
                className="editing-tool-rail-ingest"
                onClick={onImport}
                title="Import audio files"
              >
                Import
              </Button>
            </>
          ) : null}
          {bladeAllowed && toolMode === "blade" && !commentMode ? (
            <Button
              onClick={onCutAtPlayhead}
              title="Cut selected tracks at playhead"
            >
              {commandLabel("edit.bladeCut")}
            </Button>
          ) : null}
          <div className="editing-tool-rail-end">
            <ZoomControls
              zoom={zoom}
              onZoomIn={onZoomIn}
              onZoomOut={onZoomOut}
            />
            <HistoryControls
              history={history}
              onUndo={onUndo}
              onRedo={onRedo}
            />
          </div>
        </div>
      </div>
      <RailLabelPeek peek={peek} />
    </>
  );
}
