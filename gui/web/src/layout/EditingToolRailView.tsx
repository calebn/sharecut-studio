import { type ReactNode, useId } from "react";
import type { ToolMode } from "../state/types";
import { BottomSheet, Button, Icon, InlineError } from "../ui";
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
  /** Undo and Redo for people who can edit; null hides them. */
  history: { canUndo: boolean; canRedo: boolean } | null;
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
            title="Cut selected tracks at playhead"
          >
            Cut at playhead
          </Button>
        ) : null}
        {history ? (
          <div
            className="editing-tool-rail-history"
            role="group"
            aria-label="Undo and redo"
          >
            <HistoryButton
              action="undo"
              enabled={history.canUndo}
              onClick={onUndo}
            />
            <HistoryButton
              action="redo"
              enabled={history.canRedo}
              onClick={onRedo}
            />
          </div>
        ) : null}
      </div>
      {bladeAllowed ? (
        <BottomSheet
          backgroundPolicy="dismiss"
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

const HISTORY_COPY = {
  undo: { label: "Undo", reason: "Nothing to undo" },
  redo: { label: "Redo", reason: "Nothing to redo" },
} as const;

/** An icon Undo or Redo; disabled, it names why next to itself (#1077). */
function HistoryButton({
  action,
  enabled,
  onClick,
}: {
  action: keyof typeof HISTORY_COPY;
  enabled: boolean;
  onClick: () => void;
}) {
  const reasonId = useId();
  const { label, reason } = HISTORY_COPY[action];
  return (
    <>
      <Button
        className="editing-tool-rail-icon"
        aria-label={label}
        title={enabled ? label : reason}
        disabled={!enabled}
        aria-describedby={enabled ? undefined : reasonId}
        onClick={onClick}
      >
        <Icon name={action} size={20} />
      </Button>
      {enabled ? null : (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}
