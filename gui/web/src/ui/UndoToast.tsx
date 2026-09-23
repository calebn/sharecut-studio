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
import { pointerKindFromPointerType } from "../hooks/usePointerType";
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
  /** Receives focus when the toast closes while focus is inside it, or after focus fell from it to `<body>` (e.g. a focused Undo becoming disabled). */
  returnFocusRef?: RefObject<HTMLElement | null>;
};

/**
 * Short-lived polite status message with Undo / Dismiss. The live region is
 * always mounted so screen readers announce new messages. The auto-dismiss
 * timer pauses while a mouse or pen pointer is over the toast, while focus is
 * inside it, and while Undo is disabled. Touch contact does not pause it
 * (touch has no persistent hover). If the toast closes with focus inside it,
 * or after focus fell from it to `<body>` (the browser blurs a focused Undo
 * when it becomes disabled), focus moves to `returnFocusRef`.
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
  // True once focus enters the card; stays true if focus falls to <body>
  // (relatedTarget null), e.g. when the browser blurs the focused Undo button
  // because it just became `disabled` (focus fixup). Cleared only when focus
  // moves to another element outside the card.
  const focusInside = useRef(false);
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
    const inside = focusInside;
    return () => {
      const active = document.activeElement;
      const lostToBody =
        inside.current && (active === null || active === document.body);
      if (el?.contains(active) || lostToBody) {
        returnFocusEl?.focus({ preventScroll: true });
      }
    };
  }, [returnFocusRef]);
  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerKindFromPointerType(event.pointerType) !== "coarse")
      setHovered(true);
  };
  const onFocus = () => {
    focusInside.current = true;
    setFocused(true);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (event.currentTarget.contains(next)) return;
    setFocused(false);
    // Focus fell to <body> (next === null): keep the flag so closing still
    // returns focus. Focus moved to another element: the user left the toast.
    if (next !== null) focusInside.current = false;
  };
  return (
    <div
      ref={cardRef}
      className="undo-toast"
      onPointerEnter={onPointerEnter}
      onPointerLeave={() => setHovered(false)}
      onFocus={onFocus}
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
