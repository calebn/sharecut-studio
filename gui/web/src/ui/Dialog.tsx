import { type ReactNode, useId, useRef } from "react";
import { Button } from "./Button";
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
};

/**
 * Modal dialog chrome: scrim + labelled panel + Close.
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
  });

  if (!open) {
    return null;
  }

  return (
    <div
      className="ui-dialog-root command-palette-root"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
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
          <Button
            ref={closeRef}
            variant="link"
            type="button"
            onClick={dismiss}
            disabled={closeDisabled}
          >
            Close
          </Button>
        </div>
        <div className="command-palette-body">{children}</div>
      </div>
    </div>
  );
}
