import {
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { pointerKindFromPointerType } from "../hooks/usePointerType";
import { Button } from "./Button";
import { isValidFocusTarget } from "./focusTarget";

/** How long a toast stays up while not hovered or focused. */
export const TOAST_MS = 8000;

export const TOAST_UNDO_MS = 60_000;

/**
 * Most a toast waits, in total, while it reports as clipped. It protects
 * reading time while a sheet or the browser toolbar settles; a card that stays
 * clipped (a short viewport, an expanded Safari toolbar) then runs out its
 * lifetime like any other.
 */
export const TOAST_CLIPPED_MAX_MS = TOAST_MS;

function subscribeToFocus(notify: () => void): () => void {
  document.addEventListener("focusin", notify);
  document.addEventListener("focusout", notify);
  return () => {
    document.removeEventListener("focusin", notify);
    document.removeEventListener("focusout", notify);
  };
}

export type ToastState = {
  id: number;
  message: string;
  /** `error` is a failure with its next step; it never shares the status look. */
  tone?: "status" | "error";
};

type Props = {
  /** Current toast; null hides it while the region stays mounted. A new `id` restarts the timer. */
  toast: ToastState | null;
  onDismiss: () => void;
  /** Shows Undo; leave it out when there is nothing to undo. */
  onUndo?: () => void;
  /** The action's name when "Undo" is not enough ("Undo all" on a merged toast). */
  undoLabel?: string;
  /** A decorative glyph before the message (the design system toast leads with an icon). */
  icon?: ReactNode;
  /** Why Undo is unavailable. Disables Undo and pauses auto-dismiss (Undo must never expire while it cannot be clicked). */
  undoDisabledReason?: string;
  /** Says why a pressable Undo will not act at once ("Undo ready after save"). Shown under the message; pauses auto-dismiss like a disabled reason. */
  undoNote?: string;
  timeoutMs?: number;
  visibility?: "visible" | "clipped";
  /** Receives focus when the toast closes while focus is inside it, or after focus fell from it to `<body>` (e.g. a focused Undo becoming disabled). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Placement class for the region. */
  className?: string;
  /** The always-mounted region, for a caller that positions it (the phone dock). */
  regionRef?: RefObject<HTMLDivElement | null>;
};

/**
 * Short-lived message with optional Undo and Dismiss. The region is always
 * mounted and never a live region: the shell's `StatusLiveRegion` speaks every
 * message `announceStatus` sends, and `feedback/FeedbackToast` is the only
 * caller. The auto-dismiss timer pauses while a mouse or pen
 * pointer is over the toast, while focus is inside it, and while Undo is
 * disabled. It also pauses while the card is clipped, for at most
 * `TOAST_CLIPPED_MAX_MS` in all. Touch contact does not pause it (touch has no persistent hover).
 * If the toast closes with focus inside it, or after focus fell from it to
 * `<body>` (the browser blurs a focused Undo when it becomes disabled), focus
 * moves to `returnFocusRef`.
 */
export function Toast({ toast, className, regionRef, ...rest }: Props) {
  const regionClass = className
    ? `ui-toast-region ${className}`
    : "ui-toast-region";
  return (
    <div ref={regionRef} className={regionClass}>
      {toast ? <ToastCard toast={toast} {...rest} /> : null}
    </div>
  );
}

type CardProps = Omit<Props, "toast" | "className" | "regionRef"> & {
  toast: ToastState;
};

/**
 * Mounted only while a toast is shown. Hover / focus state lives here so it
 * survives a new toast `id` replacing the old one (same DOM node, no
 * enter/focus events) and resets when the toast closes.
 */
function ToastCard({
  toast,
  onUndo,
  undoLabel = "Undo",
  icon,
  onDismiss,
  undoDisabledReason,
  undoNote,
  timeoutMs = TOAST_MS,
  visibility = "visible",
  returnFocusRef,
}: CardProps) {
  const messageId = useId();
  const noteId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  // True once focus enters the card; stays true if focus falls to <body>
  // (relatedTarget null), e.g. when the browser blurs the focused Undo button
  // because it just became `disabled` (focus fixup). Cleared only when focus
  // moves to another element outside the card.
  const focusInside = useRef(false);
  const [hovered, setHovered] = useState(false);
  // Read from the document after every commit, not tracked from events: a host
  // move can detach the focused action with no blur event (WebKit, Firefox).
  const focused = useSyncExternalStore(
    subscribeToFocus,
    () => cardRef.current?.contains(document.activeElement) ?? false,
  );
  const [clippedSpentFor, setClippedSpentFor] = useState<number | null>(null);
  const clipBudget = useRef({ id: toast.id, remaining: TOAST_CLIPPED_MAX_MS });
  const paused =
    hovered ||
    focused ||
    (onUndo != null &&
      (undoDisabledReason !== undefined || undoNote !== undefined)) ||
    (visibility === "clipped" && clippedSpentFor !== toast.id);
  const toastId = toast.id;
  const dismiss = useEffectEvent(onDismiss);
  const lifetime = useRef({ id: toastId, remaining: timeoutMs });
  const returnFocus = useEffectEvent(() => {
    const target = returnFocusRef?.current ?? null;
    if (isValidFocusTarget(target)) target.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (lifetime.current.id !== toastId)
      lifetime.current = { id: toastId, remaining: timeoutMs };
    if (paused) return;
    const started = Date.now();
    const timer = window.setTimeout(
      () => dismiss(),
      lifetime.current.remaining,
    );
    return () => {
      window.clearTimeout(timer);
      lifetime.current.remaining = Math.max(
        0,
        lifetime.current.remaining - (Date.now() - started),
      );
    };
  }, [toastId, paused, timeoutMs]);
  const clippedWaiting =
    visibility === "clipped" && clippedSpentFor !== toastId;
  useEffect(() => {
    if (clipBudget.current.id !== toastId)
      clipBudget.current = { id: toastId, remaining: TOAST_CLIPPED_MAX_MS };
    if (!clippedWaiting) return;
    const started = Date.now();
    const timer = window.setTimeout(
      () => setClippedSpentFor(toastId),
      clipBudget.current.remaining,
    );
    return () => {
      window.clearTimeout(timer);
      clipBudget.current.remaining = Math.max(
        0,
        clipBudget.current.remaining - (Date.now() - started),
      );
    };
  }, [toastId, clippedWaiting]);
  useLayoutEffect(() => {
    const el = cardRef.current;
    const inside = focusInside;
    return () => {
      const active = document.activeElement;
      const lostToBody =
        inside.current && (active === null || active === document.body);
      if (el?.contains(active) || lostToBody) {
        returnFocus();
      }
    };
  }, [returnFocusRef]);
  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerKindFromPointerType(event.pointerType) !== "coarse")
      setHovered(true);
  };
  const onFocus = () => {
    focusInside.current = true;
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (event.currentTarget.contains(next)) return;
    // Focus fell to <body> (next === null): keep the flag so closing still
    // returns focus. Focus moved to another element: the user left the toast.
    if (next !== null) focusInside.current = false;
  };
  return (
    <div
      ref={cardRef}
      className={
        toast.tone === "error" ? "ui-toast ui-toast--error" : "ui-toast"
      }
      onPointerEnter={onPointerEnter}
      onPointerLeave={() => setHovered(false)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {icon ? (
        <span className="ui-toast-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span id={messageId} className="ui-toast-message">
        {toast.message}
      </span>
      {onUndo ? (
        <Button
          disabledReason={undoDisabledReason}
          aria-describedby={
            undoNote === undefined ? messageId : `${messageId} ${noteId}`
          }
          onClick={onUndo}
        >
          {undoLabel}
        </Button>
      ) : null}
      <Button variant="link" onClick={onDismiss}>
        Dismiss
      </Button>
      {onUndo && undoNote !== undefined ? (
        <span id={noteId} className="ui-toast-note">
          {undoNote}
        </span>
      ) : null}
    </div>
  );
}
