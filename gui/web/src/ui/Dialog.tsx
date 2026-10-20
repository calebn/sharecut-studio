import { type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseButton } from "./CloseButton";
import { useDialogModal } from "./useDialogModal";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Extra class on the panel (e.g. bounce-dialog-panel). */
  panelClassName?: string;
  /** Initial focus; defaults to Close. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Keep the dialog open (no scrim/Escape/Close dismiss). */
  closeDisabled?: boolean;
  /** Actions pinned below the scrolling body, such as the primary action. */
  footer?: ReactNode;
  /**
   * Phone and tablet raise a dialog as a bottom sheet. A dialog that must stay
   * a centered card there says why; the reason is for the next reader.
   */
  centeredReason?: string;
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
  centeredReason,
  descriptionId,
  shortcuts,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dismiss = closeDisabled ? () => undefined : onClose;

  useDialogModal({
    open,
    onClose: dismiss,
    panelRef,
    initialFocusRef: initialFocusRef ?? closeRef,
    mode: "modal",
    shortcuts,
  });

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className={
        centeredReason
          ? "ui-dialog-root command-palette-root ui-dialog-root--centered"
          : "ui-dialog-root command-palette-root"
      }
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <button
        type="button"
        className="command-palette-scrim"
        aria-label={`Close ${title}`}
        onClick={dismiss}
        disabled={closeDisabled}
      />
      <div
        ref={panelRef}
        className={
          panelClassName
            ? `command-palette-panel ${panelClassName}`
            : "command-palette-panel"
        }
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
