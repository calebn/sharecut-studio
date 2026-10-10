import { type ReactNode } from "react";
import type { ToolMode } from "../state/types";
import { BottomSheet, Button, InlineError } from "../ui";
import { formatTime } from "../utils/time";
import { HistoryControls } from "./HistoryControls";
import type { HistoryAvailability } from "./useHistoryControls";

export interface EditingToolRailViewProps {
  inert?: boolean;
  bladeAllowed: boolean;
  mayIngest: boolean;
  toolMode: ToolMode;
  commentMode: boolean;
  busy: boolean;
  error: string | null;
  bladeConfirmSec: number | null;
  trackIdsForCut: readonly string[];
  toolToggle: ReactNode;
  /** Undo and Redo for people who can edit; null hides them. */
  history: HistoryAvailability | null;
  onUndo: () => void;
  onRedo: () => void;
  onAddTrack: () => void;
  onImport: () => void;
  onCutAtPlayhead: () => void;
  onCancelCut: () => void;
  onConfirmCut: () => void;
}

/** Store-free Ferrite-style bottom tool rail + blade confirm sheet (phone/tablet). */
export function EditingToolRailView({
  inert = false,
  bladeAllowed,
  mayIngest,
  toolMode,
  commentMode,
  busy,
  error,
  bladeConfirmSec,
  trackIdsForCut,
  toolToggle,
  history,
  onUndo,
  onRedo,
  onAddTrack,
  onImport,
  onCutAtPlayhead,
  onCancelCut,
  onConfirmCut,
}: EditingToolRailViewProps) {
  if (!bladeAllowed && !mayIngest && !history) {
    return null;
  }

  return (
    <>
      <div
        className="editing-tool-rail"
        inert={inert}
        role="group"
        aria-label="Editing tools"
      >
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
            disabled={busy}
            onClick={onCutAtPlayhead}
            title="Cut selected tracks at playhead"
          >
            Cut at playhead
          </Button>
        ) : null}
        <HistoryControls history={history} onUndo={onUndo} onRedo={onRedo} />
      </div>
      {bladeAllowed ? (
        <BottomSheet
          backgroundPolicy="dismiss"
          open={bladeConfirmSec != null}
          onClose={onCancelCut}
          title="Confirm blade cut"
          size="fit"
        >
          {bladeConfirmSec != null ? (
            <div className="blade-confirm-sheet">
              <p>
                Split at <strong>{formatTime(bladeConfirmSec)}</strong> on{" "}
                {trackIdsForCut.length
                  ? trackIdsForCut.join(", ")
                  : "all dialogue tracks"}
                .
              </p>
              <InlineError message={error} />
              <div className="blade-confirm-actions">
                <Button disabled={busy} onClick={onCancelCut}>
                  Cancel
                </Button>
                <Button disabled={busy} onClick={onConfirmCut}>
                  {busy ? "Cutting…" : "Cut"}
                </Button>
              </div>
            </div>
          ) : null}
        </BottomSheet>
      ) : null}
    </>
  );
}
