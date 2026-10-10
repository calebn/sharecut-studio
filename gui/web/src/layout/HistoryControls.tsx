import { useEffect, useId, useState } from "react";
import { Button, Icon } from "../ui";
import {
  type HistoryAvailability,
  useHistoryControls,
} from "./useHistoryControls";

type HistoryAction = "undo" | "redo";

const HISTORY_COPY = {
  undo: { label: "Undo", reason: "Nothing to undo" },
  redo: { label: "Redo", reason: "Nothing to redo" },
} as const;
const HINT_MS = 3500;

export function CompactHistoryControls() {
  const controls = useHistoryControls();
  return (
    <HistoryControls
      {...controls}
      className="compact-history-controls"
      hintClassName="compact-history-hint"
    />
  );
}

export function HistoryControls({
  history,
  onUndo,
  onRedo,
  className = "editing-tool-rail-history",
  hintClassName = "editing-tool-rail-hint",
}: {
  history: HistoryAvailability | null;
  onUndo: () => void;
  onRedo: () => void;
  className?: string;
  hintClassName?: string;
}) {
  const [blocked, setBlocked] = useState<{ action: HistoryAction } | null>(
    null,
  );
  useEffect(() => {
    if (!blocked) return;
    const timer = window.setTimeout(() => setBlocked(null), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [blocked]);
  if (!history) return null;
  const reason =
    blocked && !enabled(history, blocked.action)
      ? HISTORY_COPY[blocked.action].reason
      : "";

  return (
    <div className={className} role="group" aria-label="Undo and redo">
      <HistoryButton
        action="undo"
        available={history.canUndo}
        onClick={onUndo}
        onBlocked={() => setBlocked({ action: "undo" })}
      />
      <HistoryButton
        action="redo"
        available={history.canRedo}
        onClick={onRedo}
        onBlocked={() => setBlocked({ action: "redo" })}
      />
      <span className={hintClassName} role="status">
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
  onClick,
  onBlocked,
}: {
  action: HistoryAction;
  available: boolean;
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
      <Icon name={action} size={20} />
      {available ? null : (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </Button>
  );
}
