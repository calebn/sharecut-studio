import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { CloseButton } from "./CloseButton";
import { revealBelowChrome } from "./focusAndReveal";
import { useDialogModal } from "./useDialogModal";
import { useDrawerSwipe } from "./useDrawerSwipe";
import { useResizeObserver } from "./useResizeObserver";

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
 * `detents`, lowest first, and a flick carries it on (`useDrawerSwipe`).
 * Expand and Collapse stay as buttons, and a native range input (visually
 * hidden, named `label`) gives keyboards and screen readers the same detents.
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
  const swipe = useDrawerSwipe(panelRef, open ? drawer : undefined);
  const chromeRef = useRef<HTMLDivElement>(null);
  // The drawer's chrome stays pinned while its body scrolls; the panel's
  // scroll padding keeps a focused or revealed control clear of it.
  useResizeObserver(
    chromeRef,
    () => {
      const panel = panelRef.current;
      const chrome = chromeRef.current;
      if (panel && chrome) {
        panel.style.setProperty(
          "--sheet-chrome-block-size",
          `${chrome.offsetHeight}px`,
        );
      }
    },
    drawer != null,
  );
  const hasDrawer = drawer != null;
  // A focused control is scrolled clear of the pinned header, which WebKit
  // does not do for a field it counts as partly in view.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !hasDrawer || !panel) return;
    const reveal = (event: FocusEvent) => {
      const chrome = chromeRef.current;
      if (chrome && event.target instanceof HTMLElement) {
        revealBelowChrome(panel, chrome, event.target);
      }
    };
    panel.addEventListener("focusin", reveal);
    return () => panel.removeEventListener("focusin", reveal);
  }, [open, hasDrawer]);
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
          className={`bottom-sheet-scrim bottom-sheet-scrim--interactive${current === "peek" ? " bottom-sheet-scrim--clear" : ""}`}
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
        className={`bottom-sheet bottom-sheet--${current}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby={title ? titleId : undefined}
      >
        <div
          ref={chromeRef}
          className={`bottom-sheet-chrome${drawer ? " bottom-sheet-chrome--drawer" : ""}`}
          {...(drawer ? swipe : {})}
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
