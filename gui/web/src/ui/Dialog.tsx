import { type ReactNode, useEffect, useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useStableCallback } from "../utils/useStableCallback";
import { CloseButton } from "./CloseButton";
import { type DialogAnchor, useAnchoredPanel } from "./useAnchoredPanel";
import { useDialogModal } from "./useDialogModal";
import { useModalOpen } from "./useModalOpen";
import { useOutsidePointerDown } from "./useOutsidePointerDown";
import { useTopLayerPanel } from "./useTopLayerPanel";

type Props = {
  /** Anchored preserve-focus dismissal keeps outside focus; Close and Escape restore the opener. The default restores the anchor. */
  outsideDismissal?: "restore-anchor" | "preserve-focus";
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Extra class on the panel (e.g. share-dialog-panel). */
  panelClassName?: string;
  /**
   * `end` docks the panel full height to the end edge of a desktop or tablet screen, as a side
   * sheet. A phone still raises it from the bottom.
   */
  edge?: "end";
  /** Initial focus; defaults to Close. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Keep the dialog open (no scrim/Escape/Close dismiss). */
  closeDisabled?: boolean;
  /** Actions pinned below the scrolling body, such as the primary action. */
  footer?: ReactNode;
  /** A control before the title, such as Back on a pushed step. */
  headerStart?: ReactNode;
  /** Controls after the title, before Close. */
  headerEnd?: ReactNode;
  /**
   * The panel covers the whole screen and brings its own way out (a Done in
   * `headerEnd`): the title is only the accessible name, the scrim is out of
   * the tab order and Close is not drawn. Needs `initialFocusRef`.
   */
  fullScreen?: boolean;
  /**
   * A dialog about a spot the person must keep seeing (the join under the
   * timeline) stays a non-modal panel beside it on every shell, in the top
   * layer. It closes on a press outside or when a modal opens; the page
   * behind stays usable.
   */
  anchor?: DialogAnchor;
  /** `id` of the panel, for a trigger's `aria-controls`. */
  panelId?: string;
  /** Body text that describes the dialog (`aria-describedby`), e.g. a confirm's consequence. */
  descriptionId?: string;
  /** Keymap command ids let through while open; every other app shortcut is held. */
  shortcuts?: readonly string[];
};

/**
 * Modal dialog chrome: scrim + labelled panel + Close, a centered card on
 * desktop and a bottom sheet on phone and tablet (the primary action goes in
 * `footer`, which stays pinned in the thumb zone).
 * Uses useDialogModal (trap, inert chrome, Escape, restore).
 */
export function Dialog({
  outsideDismissal = "restore-anchor",
  open,
  onClose,
  title,
  children,
  panelClassName,
  edge,
  initialFocusRef,
  closeDisabled = false,
  footer,
  headerStart,
  headerEnd,
  fullScreen = false,
  anchor,
  panelId,
  descriptionId,
  shortcuts,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const focusRef = useMemo(
    () => ({
      get current() {
        return initialFocusRef?.current ?? closeRef.current;
      },
    }),
    [initialFocusRef],
  );
  const dismiss = closeDisabled ? () => undefined : onClose;

  const anchored = anchor != null;
  const modalOpen = useModalOpen();
  const dismissNow = useStableCallback(dismiss);
  useEffect(() => {
    if (anchored && open && modalOpen) dismissNow();
  }, [anchored, open, modalOpen, dismissNow]);
  const topLayer = useTopLayerPanel();

  useDialogModal({
    open,
    onClose: dismiss,
    panelRef,
    initialFocusRef: focusRef,
    returnFocusRef:
      anchored && outsideDismissal === "preserve-focus"
        ? undefined
        : anchor?.ref,
    mode: anchored ? "sheet" : "modal",
    shortcuts,
  });
  useAnchoredPanel(panelRef, anchor, open);
  useOutsidePointerDown(
    [
      panelRef,
      ...(anchor ? [anchor.ref] : []),
      ...(anchor?.avoidRef ? [anchor.avoidRef] : []),
    ],
    dismiss,
    open && anchored,
    { capture: anchored && outsideDismissal === "preserve-focus" },
  );

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={anchored ? topLayer.ref : undefined}
      popover={anchored ? topLayer.popover : undefined}
      className={
        anchored
          ? "ui-dialog-root ui-dialog-root--anchored"
          : edge
            ? `ui-dialog-root command-palette-root ui-dialog-root--${edge}`
            : "ui-dialog-root command-palette-root"
      }
      role={anchored ? undefined : "dialog"}
      aria-modal={anchored ? undefined : true}
      aria-labelledby={anchored ? undefined : titleId}
      aria-describedby={anchored ? undefined : descriptionId}
    >
      {anchored ? null : (
        <button
          type="button"
          className="command-palette-scrim"
          aria-label={`Close ${title}`}
          aria-hidden={fullScreen || undefined}
          tabIndex={fullScreen ? -1 : undefined}
          onClick={dismiss}
          disabled={closeDisabled}
        />
      )}
      <div
        ref={panelRef}
        id={panelId}
        className={
          panelClassName
            ? `command-palette-panel ${panelClassName}`
            : "command-palette-panel"
        }
        role={anchored ? "dialog" : undefined}
        aria-modal={anchored ? false : undefined}
        aria-labelledby={anchored ? titleId : undefined}
        aria-describedby={anchored ? descriptionId : undefined}
      >
        <div className="command-palette-header">
          {headerStart ? (
            <div className="command-palette-heading">
              {headerStart}
              <h2 id={titleId} className={fullScreen ? "sr-only" : undefined}>
                {title}
              </h2>
            </div>
          ) : (
            <h2 id={titleId} className={fullScreen ? "sr-only" : undefined}>
              {title}
            </h2>
          )}
          {headerEnd ? (
            <div className="command-palette-header-end">{headerEnd}</div>
          ) : null}
          {fullScreen ? null : (
            <CloseButton
              ref={closeRef}
              onClick={(event) => {
                if (anchored && outsideDismissal === "preserve-focus")
                  event.currentTarget.focus({ preventScroll: true });
                dismiss();
              }}
              disabled={closeDisabled}
            />
          )}
        </div>
        <div
          className="command-palette-body"
          tabIndex={0}
          role="region"
          aria-label={`${title} content`}
        >
          {children}
        </div>
        {footer ? <div className="command-palette-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
