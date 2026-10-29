import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseButton } from "./CloseButton";
import { type DialogAnchor, useAnchoredPanel } from "./useAnchoredPanel";
import { useDialogModal } from "./useDialogModal";
import { useModalOpen } from "./useModalOpen";
import { useOutsidePointerDown } from "./useOutsidePointerDown";
import { useTopLayerPanel } from "./useTopLayerPanel";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Extra class on the panel (e.g. models-dialog-panel). */
  panelClassName?: string;
  /** Initial focus; defaults to Close. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Keep the dialog open (no scrim/Escape/Close dismiss). */
  closeDisabled?: boolean;
  /** Actions pinned below the scrolling body, such as the primary action. */
  footer?: ReactNode;
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
  open,
  onClose,
  title,
  children,
  panelClassName,
  initialFocusRef,
  closeDisabled = false,
  footer,
  anchor,
  panelId,
  descriptionId,
  shortcuts,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dismiss = closeDisabled ? () => undefined : onClose;

  const anchored = anchor != null;
  const modalOpen = useModalOpen();
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (anchored && open && modalOpen) dismissRef.current();
  }, [anchored, open, modalOpen]);
  const topLayer = useTopLayerPanel();

  useDialogModal({
    open,
    onClose: dismiss,
    panelRef,
    initialFocusRef: initialFocusRef ?? closeRef,
    returnFocusRef: anchor?.ref,
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
          <h2 id={titleId}>{title}</h2>
          <CloseButton
            ref={closeRef}
            onClick={dismiss}
            disabled={closeDisabled}
          />
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
