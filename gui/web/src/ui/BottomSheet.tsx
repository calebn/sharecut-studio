import { type ReactNode, useCallback, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { CloseButton } from "./CloseButton";
import { useDialogModal } from "./useDialogModal";

export type BottomSheetSize = "half" | "full";
export type BottomSheetBackgroundPolicy = "interactive" | "dismiss";

type Props = {
  open: boolean;
  onClose: () => void;
  backgroundPolicy: BottomSheetBackgroundPolicy;
  title?: string;
  size?: BottomSheetSize;
  children: ReactNode;
  /** When true, expand to full height (user or parent). */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

/**
 * Transient bottom sheet for phone/tablet inspector and quick actions.
 * Peek / non-modal: Escape + focus restore; no chrome inert / Tab trap.
 * NN/G: visible Close, no stacking (parent must not nest sheets).
 */
export function BottomSheet({
  open,
  onClose,
  backgroundPolicy,
  title,
  size = "half",
  children,
  expanded,
  onExpandedChange,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isFull = expanded ?? size === "full";

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

  return createPortal(
    <div className="bottom-sheet-root" role="presentation">
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
        className={`bottom-sheet${isFull ? " bottom-sheet--full" : " bottom-sheet--half"}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby={title ? titleId : undefined}
      >
        <div className="bottom-sheet-chrome">
          <div className="bottom-sheet-header">
            {title ? (
              <h2 id={titleId} className="bottom-sheet-title">
                {title}
              </h2>
            ) : (
              <span className="bottom-sheet-title-spacer" />
            )}
            <div className="bottom-sheet-header-actions">
              {onExpandedChange ? (
                <Button
                  className="bottom-sheet-resize-action"
                  variant="link"
                  type="button"
                  onClick={() => onExpandedChange(!isFull)}
                >
                  {isFull ? "Collapse" : "Expand"}
                </Button>
              ) : null}
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
