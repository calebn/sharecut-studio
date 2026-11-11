import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { isValidFocusTarget } from "../ui/focusTarget";
import { useAnchoredPanel } from "../ui/useAnchoredPanel";
import { usePopoverKeyboard } from "../ui/useMenuKeyboard";
import { useOutsidePointerDown } from "../ui/useOutsidePointerDown";
import { useTopLayerPanel } from "../ui/useTopLayerPanel";

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Escape and Tab out of an end return focus to the chevron; a press outside or another dialog taking focus closes it and leaves focus where it went. */
export function SplitPopover({
  anchorRef,
  label,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { ref: topLayerRef, popover } = useTopLayerPanel();
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      const detach = topLayerRef(el);
      return () => {
        panelRef.current = null;
        detach?.();
      };
    },
    [topLayerRef],
  );
  useEffect(() => {
    if (isValidFocusTarget(anchorRef.current))
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [anchorRef]);
  const closeToChevron = useCallback(() => {
    if (isValidFocusTarget(anchorRef.current)) anchorRef.current.focus();
    onClose();
  }, [anchorRef, onClose]);
  useAnchoredPanel(
    panelRef,
    {
      reason:
        "The options hang off the chevron they belong to; the bar and the selection it acts on must stay visible.",
      ref: anchorRef,
      prefer: "above",
    },
    true,
  );
  useOutsidePointerDown([panelRef, anchorRef], onClose);
  usePopoverKeyboard({
    panelRef,
    anchorRef,
    close: closeToChevron,
    closeAway: onClose,
  });
  return createPortal(
    <div
      ref={attach}
      popover={popover}
      className="sys-split-popover"
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
    >
      {children}
    </div>,
    document.body,
  );
}
