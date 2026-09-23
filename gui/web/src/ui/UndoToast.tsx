import {
  type FocusEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./Button";

/** How long an undo toast stays up while not hovered or focused. */
export const UNDO_TOAST_MS = 8000;

export type UndoToastState = { id: number; message: string };

type Props = {
  /** Current toast; null hides it while the live region stays mounted. A new `id` restarts the timer. */
  toast: UndoToastState | null;
  onUndo: () => void;
  onDismiss: () => void;
  /** Disables Undo and pauses auto-dismiss (Undo must never expire while it cannot be clicked). */
  undoDisabled?: boolean;
  timeoutMs?: number;
  /** Receives focus when the toast closes while focus is inside it (Undo / Dismiss). */
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Short-lived polite status message with Undo / Dismiss. The live region is
 * always mounted so screen readers announce new messages. The auto-dismiss
 * timer pauses while a mouse or pen pointer is over the toast, while focus is
 * inside it, and while Undo is disabled. Touch contact does not pause it
 * (touch has no persistent hover). If the toast closes with focus inside,
 * focus moves to `returnFocusRef` instead of falling back to `<body>`.
 */
export function UndoToast({ toast, ...rest }: Props) {
  return (
    <div className="undo-toast-region" role="status" aria-live="polite">
      {toast ? <UndoToastCard toast={toast} {...rest} /> : null}
    </div>
  );
}

type CardProps = Omit<Props, "toast"> & { toast: UndoToastState };

/**
 * Mounted only while a toast is shown. Hover / focus state lives here so it
 * survives a new toast `id` replacing the old one (same DOM node, no
 * enter/focus events) and resets when the toast closes.
 */
function UndoToastCard({
  toast,
  onUndo,
  onDismiss,
  undoDisabled = false,
  timeoutMs = UNDO_TOAST_MS,
  returnFocusRef,
}: CardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused || undoDisabled;
  const toastId = toast.id;
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => dismiss(), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [toastId, paused, timeoutMs]);
  useLayoutEffect(() => {
    const el = cardRef.current;
    const returnFocusEl = returnFocusRef?.current ?? null;
    return () => {
      if (el?.contains(document.activeElement)) {
        returnFocusEl?.focus({ preventScroll: true });
      }
    };
  }, [returnFocusRef]);
  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") setHovered(true);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      setFocused(false);
  };
  return (
    <div
      ref={cardRef}
      className="undo-toast"
      onPointerEnter={onPointerEnter}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
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
  );
}
