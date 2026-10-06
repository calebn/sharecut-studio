import { type ReactNode, useCallback, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { CloseButton } from "./CloseButton";
import { useDialogModal } from "./useDialogModal";

/** `peek`: a content-height strip; `half` and `full`: fixed shares of the slot. */
export type BottomSheetSize = "peek" | "half" | "full";
export type BottomSheetBackgroundPolicy = "interactive" | "dismiss";

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
 * NN/G: visible Close, no stacking (parent must not nest sheets).
 * No drag gesture: Expand and Collapse are visible buttons.
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
  stowed = false,
  className,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const isExpanded = expanded ?? size === expandedSize;
  const current = isExpanded ? expandedSize : size;

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
        className={`bottom-sheet bottom-sheet--${current}${className ? ` ${className}` : ""}`}
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
                  aria-label={
                    isExpanded ? resizeLabels?.collapse : resizeLabels?.expand
                  }
                  onClick={() => onExpandedChange(!isExpanded)}
                >
                  {isExpanded ? "Collapse" : "Expand"}
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
