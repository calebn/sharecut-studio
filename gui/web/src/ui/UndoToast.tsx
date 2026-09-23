import { type FocusEvent, useEffect, useEffectEvent, useState } from "react";
import { Button } from "./Button";

/** How long an undo toast stays up while not hovered or focused. */
export const UNDO_TOAST_MS = 8000;

export type UndoToastState = { id: number; message: string };

type Props = {
  /** Current toast; null hides it while the live region stays mounted. A new `id` restarts the timer. */
  toast: UndoToastState | null;
  onUndo: () => void;
  onDismiss: () => void;
  undoDisabled?: boolean;
  timeoutMs?: number;
};

/**
 * Short-lived polite status message with Undo / Dismiss. The live region is
 * always mounted so screen readers announce new messages. The auto-dismiss
 * timer pauses while the pointer or focus is inside.
 */
export function UndoToast({
  toast,
  onUndo,
  onDismiss,
  undoDisabled = false,
  timeoutMs = UNDO_TOAST_MS,
}: Props) {
  const toastId = toast?.id ?? null;
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const paused =
    toastId != null && (hoverId === toastId || focusId === toastId);
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (toastId == null || paused) return;
    const timer = window.setTimeout(() => dismiss(), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [toastId, paused, timeoutMs]);
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      setFocusId(null);
  };
  return (
    <div className="undo-toast-region" role="status" aria-live="polite">
      {toast ? (
        <div
          className="undo-toast"
          onPointerEnter={() => setHoverId(toastId)}
          onPointerLeave={() => setHoverId(null)}
          onFocus={() => setFocusId(toastId)}
          onBlur={onBlur}
        >
          <span className="undo-toast-message">{toast.message}</span>
          <Button disabled={undoDisabled} onClick={onUndo}>
            Undo
          </Button>
          <Button variant="link" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </div>
  );
}
