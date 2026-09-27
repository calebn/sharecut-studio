import type { ReactNode } from "react";
import type { ToolMode } from "../state/types";
import { BottomSheet, Button, InlineError } from "../ui";
import { formatTime } from "../utils/time";

export interface EditingToolRailViewProps {
  bladeAllowed: boolean;
  mayIngest: boolean;
  toolMode: ToolMode;
  commentMode: boolean;
  busy: boolean;
  error: string | null;
  bladeConfirmSec: number | null;
  trackIdsForCut: readonly string[];
  toolToggle: ReactNode;
  onAddTrack: () => void;
  onImport: () => void;
  onCutAtPlayhead: () => void;
  onCancelCut: () => void;
  onConfirmCut: () => void;
}

/** Store-free Ferrite-style bottom tool rail + blade confirm sheet (phone/tablet). */
export function EditingToolRailView({
  bladeAllowed,
  mayIngest,
  toolMode,
  commentMode,
  busy,
  error,
  bladeConfirmSec,
  trackIdsForCut,
  toolToggle,
  onAddTrack,
  onImport,
  onCutAtPlayhead,
  onCancelCut,
  onConfirmCut,
}: EditingToolRailViewProps) {
  if (!bladeAllowed && !mayIngest) {
    return null;
  }

  return (
    <>
      <div
        className="editing-tool-rail"
        role="group"
        aria-label="Editing tools"
      >
        {bladeAllowed ? toolToggle : null}
        {mayIngest ? (
          <>
            <Button onClick={onAddTrack} title="Add empty track">
              + Track
            </Button>
            <Button onClick={onImport} title="Import audio files">
              Import
            </Button>
          </>
        ) : null}
        {bladeAllowed && toolMode === "blade" && !commentMode ? (
          <Button
            disabled={busy}
            onClick={onCutAtPlayhead}
            title="Split selected tracks at playhead"
          >
            Cut at playhead
          </Button>
        ) : null}
      </div>
      {bladeAllowed ? (
        <BottomSheet
          open={bladeConfirmSec != null}
          onClose={onCancelCut}
          title="Confirm blade cut"
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
