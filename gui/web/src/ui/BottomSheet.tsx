import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { CloseButton } from "./CloseButton";
import { drawerDetentAfter } from "./drawerDetents";
import { useDialogModal } from "./useDialogModal";

/** `peek`: a content-height strip; `half` and `full`: fixed shares of the slot. */
export type BottomSheetSize = "peek" | "half" | "full";
export type BottomSheetBackgroundPolicy = "interactive" | "dismiss";

/** How each detent reads to a screen reader and on the buttons' names. */
const DETENT_TEXT: Record<BottomSheetSize, string> = {
  peek: "Strip",
  half: "Half height",
  full: "Full height",
};

/**
 * A swipeable drawer (#1051 round 4b): the sheet's header drags it between
 * `detents`, lowest first. Expand and Collapse stay as buttons, and a native
 * range input (visually hidden, named `label`) gives keyboards and screen
 * readers the same detents.
 */
export interface SheetDrawer {
  detents: readonly BottomSheetSize[];
  detent: BottomSheetSize;
  onDetentChange: (detent: BottomSheetSize) => void;
  label: string;
}

type Props = {
  open: boolean;
  onClose: () => void;
  backgroundPolicy: BottomSheetBackgroundPolicy;
  title?: string;
  /** Size while not expanded. */
  size?: BottomSheetSize;
  /** Size while expanded. */
  expandedSize?: BottomSheetSize;
  children: ReactNode;
  /** When true, show `expandedSize` (user or parent). */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Accessible names of the Expand and Collapse actions. */
  resizeLabels?: { expand: string; collapse: string };
  /** Detents the header swipes between; replaces the expand toggle. */
  drawer?: SheetDrawer;
  /**
   * Moved off screen and click-through, still mounted, while the user drags
   * what it describes; it slides back when they let go.
   */
  stowed?: boolean;
  /** Extra class on the panel (the compact inspector's strip and sheet). */
  className?: string;
};

/** A header drag in progress. */
interface Swipe {
  pointerId: number;
  startY: number;
  startHeight: number;
  slot: number;
  lastY: number;
  lastAt: number;
  velocity: number;
}

/**
 * Transient bottom sheet for phone/tablet inspector and quick actions.
 * Peek / non-modal: Escape + focus restore; no chrome inert / Tab trap.
 * NN/G: visible Close, no stacking (parent must not nest sheets). Sizes
 * change with visible Expand and Collapse buttons; a `drawer` also swipes.
 */
export function BottomSheet({
  open,
  onClose,
  backgroundPolicy,
  title,
  size = "half",
  expandedSize = "full",
  children,
  expanded,
  onExpandedChange,
  resizeLabels,
  drawer,
  stowed = false,
  className,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const swipe = useRef<Swipe | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const isExpanded = expanded ?? size === expandedSize;
  const current = drawer ? drawer.detent : isExpanded ? expandedSize : size;

  const dismiss = useCallback(() => {
    onClose();
  }, [onClose]);

  // GOVERNANCE: Escape via useDialogModal — allowlisted in governance.test.ts
  useDialogModal({
    open,
    onClose: dismiss,
    panelRef,
    initialFocusRef: closeRef,
    mode: "sheet",
  });

  if (!open || typeof document === "undefined") {
    return null;
  }

  const at = drawer ? drawer.detents.indexOf(drawer.detent) : -1;
  const lowest = drawer?.detents[0];
  const higher = drawer?.detents[at + 1];
  const endSwipe = () => {
    swipe.current = null;
    setDragHeight(null);
  };
  const onSwipeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawer) return;
    // A second finger, or a press on a header button, is not a swipe.
    if (swipe.current) {
      endSwipe();
      return;
    }
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button"))
    ) {
      return;
    }
    const panel = panelRef.current;
    const slot = panel?.parentElement?.getBoundingClientRect().height ?? 0;
    swipe.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: panel?.offsetHeight ?? 0,
      slot,
      lastY: event.clientY,
      lastAt: event.timeStamp,
      velocity: 0,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onSwipeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.pointerId !== event.pointerId) return;
    const dt = event.timeStamp - s.lastAt;
    // Speed over at least 8 ms: coalesced samples say nothing about it.
    if (dt >= 8) {
      s.velocity = (event.clientY - s.lastY) / dt;
      s.lastY = event.clientY;
      s.lastAt = event.timeStamp;
    }
    const height = s.startHeight - (event.clientY - s.startY);
    setDragHeight(Math.max(0, Math.min(s.slot, height)));
  };
  const onSwipeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!drawer || !s || s.pointerId !== event.pointerId) return;
    const dyPx = event.clientY - s.startY;
    const next = drawerDetentAfter({
      detents: drawer.detents,
      current: drawer.detent,
      dyPx,
      velocity: s.velocity,
      heightPx: s.startHeight - dyPx,
      slotPx: s.slot,
    });
    endSwipe();
    if (next !== drawer.detent) drawer.onDetentChange(next);
  };

  const resizeButtons = drawer ? (
    <>
      {at > 0 && lowest ? (
        <Button
          className="bottom-sheet-resize-action"
          variant="link"
          type="button"
          aria-label={`Collapse to ${DETENT_TEXT[lowest].toLowerCase()}`}
          onClick={() => drawer.onDetentChange(lowest)}
        >
          Collapse
        </Button>
      ) : null}
      {higher ? (
        <Button
          className="bottom-sheet-resize-action"
          variant="link"
          type="button"
          aria-label={`Expand to ${DETENT_TEXT[higher].toLowerCase()}`}
          onClick={() => drawer.onDetentChange(higher)}
        >
          Expand
        </Button>
      ) : null}
    </>
  ) : onExpandedChange ? (
    <Button
      className="bottom-sheet-resize-action"
      variant="link"
      type="button"
      aria-label={isExpanded ? resizeLabels?.collapse : resizeLabels?.expand}
      onClick={() => onExpandedChange(!isExpanded)}
    >
      {isExpanded ? "Collapse" : "Expand"}
    </Button>
  ) : null;

  return createPortal(
    <div
      className={`bottom-sheet-root${stowed ? " is-stowed" : ""}`}
      role="presentation"
    >
      {backgroundPolicy === "interactive" ? (
        <div
          className="bottom-sheet-scrim bottom-sheet-scrim--interactive"
          aria-hidden="true"
        />
      ) : (
        <button
          type="button"
          className="bottom-sheet-scrim"
          aria-label="Dismiss"
          onClick={dismiss}
        />
      )}
      <div
        ref={panelRef}
        className={`bottom-sheet bottom-sheet--${current}${dragHeight != null ? " is-dragging" : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby={title ? titleId : undefined}
        style={
          dragHeight != null
            ? ({ "--sheet-drag-height": `${dragHeight}px` } as CSSProperties)
            : undefined
        }
      >
        <div
          className={`bottom-sheet-chrome${drawer ? " bottom-sheet-chrome--drawer" : ""}`}
          onPointerDown={drawer ? onSwipeDown : undefined}
          onPointerMove={drawer ? onSwipeMove : undefined}
          onPointerUp={drawer ? onSwipeUp : undefined}
          onPointerCancel={drawer ? endSwipe : undefined}
        >
          {drawer ? (
            <label className="bottom-sheet-grabber">
              <span className="sr-only">{drawer.label}</span>
              <input
                className="bottom-sheet-detent sr-only"
                type="range"
                min={0}
                max={drawer.detents.length - 1}
                step={1}
                value={at}
                aria-valuetext={DETENT_TEXT[drawer.detent]}
                onChange={(event) => {
                  const next = drawer.detents[Number(event.target.value)];
                  if (next) drawer.onDetentChange(next);
                }}
              />
            </label>
          ) : null}
          <div className="bottom-sheet-header">
            {title ? (
              <h2 id={titleId} className="bottom-sheet-title">
                {title}
              </h2>
            ) : (
              <span className="bottom-sheet-title-spacer" />
            )}
            <div className="bottom-sheet-header-actions">
              {resizeButtons}
              <CloseButton ref={closeRef} onClick={dismiss} />
            </div>
          </div>
        </div>
        <div className="bottom-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
