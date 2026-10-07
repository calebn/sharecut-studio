import { type ReactNode, useEffect, useId, useState } from "react";
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
  const [blocked, setBlocked] = useState<{ action: HistoryAction } | null>(
    null,
  );
  useEffect(() => {
    if (!blocked) {
      return;
    }
    const timer = window.setTimeout(() => setBlocked(null), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [blocked]);

  if (!bladeAllowed && !mayIngest && !history) {
    return null;
  }
  const blockedReason =
    blocked && !historyEnabled(history, blocked.action)
      ? HISTORY_COPY[blocked.action].reason
      : "";

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
              onBlocked={() => setBlocked({ action: "undo" })}
            />
            <HistoryButton
              action="redo"
              enabled={history.canRedo}
              onClick={onRedo}
              onBlocked={() => setBlocked({ action: "redo" })}
            />
          </div>
        ) : null}
        <span className="editing-tool-rail-hint" role="status">
          {blockedReason}
        </span>
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

type HistoryAction = keyof typeof HISTORY_COPY;

/** How long a tapped, unavailable Undo or Redo keeps naming its reason. */
const HINT_MS = 3500;

function historyEnabled(
  history: EditingToolRailViewProps["history"],
  action: HistoryAction,
): boolean {
  return action === "undo" ? !!history?.canUndo : !!history?.canRedo;
}

/**
 * An icon Undo or Redo (#1077). Unavailable, it stays focusable and
 * `aria-disabled`: a native disabled button swallows a tap, so a finger would
 * get nothing. The tap names the reason in the rail's status line instead;
 * hover, focus and screen readers get it as the title and description.
 */
function HistoryButton({
  action,
  enabled,
  onClick,
  onBlocked,
}: {
  action: HistoryAction;
  enabled: boolean;
  onClick: () => void;
  onBlocked: () => void;
}) {
  const reasonId = useId();
  const { label, reason } = HISTORY_COPY[action];
  return (
    <>
      <Button
        className="editing-tool-rail-icon"
        aria-label={label}
        title={enabled ? label : reason}
        aria-disabled={enabled ? undefined : true}
        aria-describedby={enabled ? undefined : reasonId}
        onClick={enabled ? onClick : onBlocked}
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
