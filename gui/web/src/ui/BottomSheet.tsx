import { type ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { Button } from "./Button";
import { CloseButton } from "./CloseButton";
import { focusAndReveal, revealBelowChrome } from "./focusAndReveal";
import { Icon } from "./Icon";
import { SheetHostPlacement } from "./sheetHost";
import { useDialogModal } from "./useDialogModal";
import { useDrawerSwipe } from "./useDrawerSwipe";
import { useSheetHost } from "./useSheetHost";

/** `peek`: a content-height strip; `half` and `full`: fixed shares of the slot. */
export type DrawerDetent = "peek" | "half" | "full";
/**
 * A drawer detent, or `fit`: a confirmation as tall as its question and its
 * actions, for a short slot (a phone held sideways) where Cancel and the action
 * must both show. It has no height rule of its own: a sheet with none is
 * content-height, capped at the slot by `.bottom-sheet`'s max-height.
 */
export type BottomSheetSize = DrawerDetent | "fit";
export type BottomSheetBackgroundPolicy = "interactive" | "dismiss";
/**
 * `sheet`: portaled over the shell, with a scrim, detents and a slide-up.
 * `column`: a grid cell on the inline end of the shell (#1696), for a phone
 * held sideways. It has no scrim, drawer or resize buttons; the title, Close,
 * Escape and focus restore stay. Both portal into one host element that only
 * changes parent (`sheetHost`), so turning the phone keeps the tree mounted.
 */
export type SheetPlacement = "sheet" | "column";

/** How each detent reads to a screen reader and on the buttons' names. */
const DETENT_TEXT: Record<DrawerDetent, string> = {
  peek: "Strip",
  half: "Half height",
  full: "Full height",
};

/**
 * A swipeable drawer (#1051 round 4b): the sheet's header drags it between
 * `detents`, lowest first, and a flick carries it on (`useDrawerSwipe`).
 * Expand and Collapse stay as icon buttons, and a native range input (visually
 * hidden, named `label`) gives keyboards and screen readers the same detents.
 */
export interface SheetDrawer {
  detents: readonly DrawerDetent[];
  detent: DrawerDetent;
  onDetentChange: (detent: DrawerDetent) => void;
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
  /** First content in the scrolling body, below the pinned chrome. */
  bodyHeader?: ReactNode;
  /** When true, show `expandedSize` (user or parent). */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Accessible names of the Expand and Collapse actions. */
  resizeLabels?: { expand: string; collapse: string };
  /** Additional actions for a compact inspector header. */
  compactHeaderActions?: ReactNode;
  /** Detents the header swipes between; replaces the expand toggle. */
  drawer?: SheetDrawer;
  /**
   * Moved off screen and click-through, still mounted, while the user drags
   * what it describes; it slides back when they let go.
   */
  stowed?: boolean;
  /** Extra class on the panel (the compact inspector's strip and sheet). */
  className?: string;
  placement?: SheetPlacement;
};

/**
 * Transient bottom sheet for phone/tablet inspector and quick actions.
 * Peek / non-modal: Escape + focus restore; no chrome inert / Tab trap.
 * NN/G: visible Close, no stacking (parent must not nest sheets). Sizes
 * change with Expand and Collapse icon buttons; a `drawer` also swipes.
 */
export function BottomSheet({
  open,
  onClose,
  backgroundPolicy,
  title,
  size = "half",
  expandedSize = "full",
  children,
  bodyHeader,
  expanded,
  onExpandedChange,
  resizeLabels,
  compactHeaderActions,
  drawer: requestedDrawer,
  stowed = false,
  className,
  placement = "sheet",
}: Props) {
  const column = placement === "column";
  const drawer = column ? undefined : requestedDrawer;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const swipe = useDrawerSwipe(panelRef, open ? drawer : undefined);
  const chromeRef = useRef<HTMLDivElement>(null);
  const hasDrawer = drawer != null;
  const host = useSheetHost();
  useKeyboardInset(open);
  // A focused control is scrolled clear of the pinned header, which WebKit
  // does not do for a field it counts as partly in view.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !hasDrawer || !panel) return;
    const reveal = (event: FocusEvent) => {
      const chrome = chromeRef.current;
      if (chrome && event.target instanceof HTMLElement) {
        if (panel.matches(".bottom-sheet--compact")) {
          if (!chrome.contains(event.target)) focusAndReveal(event.target);
        } else revealBelowChrome(panel, chrome, event.target);
      }
    };
    panel.addEventListener("focusin", reveal);
    return () => panel.removeEventListener("focusin", reveal);
  }, [open, hasDrawer, className]);
  // Collapsing to the strip shows its top again. The body keeps the scroll it
  // had open, which the strip would otherwise clamp to its end, leaving the
  // first nudge out of view when the strip fills a short, large-text screen
  // (#1762).
  const atLowest = drawer != null && drawer.detent === drawer.detents[0];
  useEffect(() => {
    const body = panelRef.current?.querySelector(".bottom-sheet-body");
    if (open && atLowest && body) body.scrollTop = 0;
  }, [open, atLowest]);
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
    stackKey: title ?? "bottom-sheet",
  });

  if (!open || !host) {
    return null;
  }

  const resizeLabel = isExpanded
    ? (resizeLabels?.collapse ?? "Collapse")
    : (resizeLabels?.expand ?? "Expand");
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
          title={`Collapse to ${DETENT_TEXT[lowest].toLowerCase()}`}
          onClick={() => drawer.onDetentChange(lowest)}
        >
          <Icon name="restore" size={20} />
        </Button>
      ) : null}
      {higher ? (
        <Button
          className="bottom-sheet-resize-action"
          variant="link"
          type="button"
          aria-label={`Expand to ${DETENT_TEXT[higher].toLowerCase()}`}
          title={`Expand to ${DETENT_TEXT[higher].toLowerCase()}`}
          onClick={() => drawer.onDetentChange(higher)}
        >
          <Icon name="maximize" size={20} />
        </Button>
      ) : null}
    </>
  ) : onExpandedChange && !column ? (
    <Button
      className="bottom-sheet-resize-action"
      variant="link"
      type="button"
      aria-label={resizeLabel}
      title={resizeLabel}
      onClick={() => onExpandedChange(!isExpanded)}
    >
      <Icon name={isExpanded ? "restore" : "maximize"} size={20} />
    </Button>
  ) : null;

  const panel = (
    <div
      ref={panelRef}
      className={`bottom-sheet ${column ? "bottom-sheet--column" : `bottom-sheet--${current}`}${className ? ` ${className}` : ""}`}
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
            {compactHeaderActions}
            {resizeButtons}
            <CloseButton ref={closeRef} onClick={dismiss} />
          </div>
        </div>
      </div>
      <div className="bottom-sheet-body">
        {bodyHeader}
        {children}
      </div>
    </div>
  );

  return createPortal(
    <>
      <SheetHostPlacement host={host} column={column} stowed={stowed} />
      {column ? null : backgroundPolicy === "interactive" ? (
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
      {panel}
    </>,
    host,
  );
}
