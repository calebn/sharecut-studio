import { useEffect, useId, useState } from "react";
import { commandLabel } from "../../commands/labels";
import { readyAfterSaveCopy } from "../../commands/undoWait";
import { Button, Icon } from "../../ui";
import {
  type HistoryAvailability,
  useHistoryControls,
} from "./useHistoryControls";

type HistoryAction = "undo" | "redo";
type HistoryVariant = "rail" | "compact";

const HISTORY_COPY = {
  undo: {
    label: commandLabel("history.undo"),
    reason: "Nothing to undo",
    caption: "undo",
  },
  redo: {
    label: commandLabel("history.redo"),
    reason: "Nothing to redo",
    caption: "redo",
  },
} as const;
const HINT_MS = 3500;

export function CompactHistoryControls() {
  const controls = useHistoryControls();
  return <HistoryControls {...controls} variant="compact" />;
}

export function HistoryControls({
  history,
  saving = false,
  onUndo,
  onRedo,
  variant = "rail",
}: {
  history: HistoryAvailability | null;
  /** A save or drain is running: a press waits for it, and the buttons say so. */
  saving?: boolean;
  onUndo: () => void;
  onRedo: () => void;
  variant?: HistoryVariant;
}) {
  const [blocked, setBlocked] = useState<{ action: HistoryAction } | null>(
    null,
  );
  const selectedActionAvailable = blocked
    ? enabled(history, blocked.action)
    : false;
  const historyMissing = history === null;
  useEffect(() => {
    if (!blocked) return;
    if (historyMissing || selectedActionAvailable) {
      setBlocked(null);
      return;
    }
    const timer = window.setTimeout(() => setBlocked(null), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [blocked, historyMissing, selectedActionAvailable]);
  if (!history) return null;
  const blockedAction =
    blocked && !selectedActionAvailable ? blocked.action : null;
  const reason = blockedAction ? HISTORY_COPY[blockedAction].reason : "";

  return (
    <div
      className={
        variant === "compact"
          ? "compact-history-controls"
          : "editing-tool-rail-history"
      }
      role="group"
      aria-label="Undo and redo"
    >
      <HistoryButton
        action="undo"
        available={history.canUndo}
        saving={saving}
        showBlockedCaption={variant === "compact" && blockedAction === "undo"}
        onClick={onUndo}
        onBlocked={() => setBlocked({ action: "undo" })}
      />
      <HistoryButton
        action="redo"
        available={history.canRedo}
        saving={saving}
        showBlockedCaption={variant === "compact" && blockedAction === "redo"}
        onClick={onRedo}
        onBlocked={() => setBlocked({ action: "redo" })}
      />
      <span
        className={variant === "compact" ? "sr-only" : "editing-tool-rail-hint"}
        role="status"
      >
        {reason}
      </span>
    </div>
  );
}

function enabled(
  history: HistoryAvailability | null,
  action: HistoryAction,
): boolean {
  return action === "undo" ? !!history?.canUndo : !!history?.canRedo;
}

function HistoryButton({
  action,
  available,
  saving,
  showBlockedCaption,
  onClick,
  onBlocked,
}: {
  action: HistoryAction;
  available: boolean;
  saving: boolean;
  showBlockedCaption: boolean;
  onClick: () => void;
  onBlocked: () => void;
}) {
  const reasonId = useId();
  const { label, reason } = HISTORY_COPY[action];
  const waiting = available && saving ? readyAfterSaveCopy(action) : undefined;
  return (
    <Button
      className="editing-tool-rail-icon"
      aria-label={label}
      title={available ? (waiting ?? label) : reason}
      aria-disabled={available ? undefined : true}
      aria-describedby={available ? (waiting ? reasonId : undefined) : reasonId}
      onClick={available ? onClick : onBlocked}
    >
      <Icon
        name={action}
        size={20}
        className={
          showBlockedCaption ? "history-controls-icon--hidden" : undefined
        }
      />
      {showBlockedCaption ? (
        <span className="compact-history-caption" aria-hidden="true">
          <span>No</span>
          <span>{HISTORY_COPY[action].caption}</span>
        </span>
      ) : null}
      {available && !waiting ? null : (
        <span id={reasonId} className="sr-only">
          {waiting ?? reason}
        </span>
      )}
    </Button>
  );
}
