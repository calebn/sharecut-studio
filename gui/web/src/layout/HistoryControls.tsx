import { useEffect, useId, useState } from "react";
import { Button, Icon } from "../ui";
import {
  type HistoryAvailability,
  useHistoryControls,
} from "./useHistoryControls";

type HistoryAction = "undo" | "redo";
type HistoryVariant = "rail" | "compact";

const HISTORY_COPY = {
  undo: { label: "Undo", reason: "Nothing to undo", caption: "undo" },
  redo: { label: "Redo", reason: "Nothing to redo", caption: "redo" },
} as const;
const HINT_MS = 3500;

export function CompactHistoryControls() {
  const controls = useHistoryControls();
  return <HistoryControls {...controls} variant="compact" />;
}

export function HistoryControls({
  history,
  onUndo,
  onRedo,
  variant = "rail",
}: {
  history: HistoryAvailability | null;
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
  useEffect(() => {
    if (!blocked) return;
    if (selectedActionAvailable) {
      setBlocked(null);
      return;
    }
    const timer = window.setTimeout(() => setBlocked(null), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [blocked, selectedActionAvailable]);
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
        showBlockedCaption={variant === "compact" && blockedAction === "undo"}
        onClick={onUndo}
        onBlocked={() => setBlocked({ action: "undo" })}
      />
      <HistoryButton
        action="redo"
        available={history.canRedo}
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
  showBlockedCaption,
  onClick,
  onBlocked,
}: {
  action: HistoryAction;
  available: boolean;
  showBlockedCaption: boolean;
  onClick: () => void;
  onBlocked: () => void;
}) {
  const reasonId = useId();
  const { label, reason } = HISTORY_COPY[action];
  return (
    <Button
      className="editing-tool-rail-icon"
      aria-label={label}
      title={available ? label : reason}
      aria-disabled={available ? undefined : true}
      aria-describedby={available ? undefined : reasonId}
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
      {available ? null : (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </Button>
  );
}
