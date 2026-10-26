import { type ReactNode, useId } from "react";

export type CoachTipProps = {
  /** The element the hint points at. */
  children: ReactNode;
  /** One line. */
  text: string;
  placement?: "below" | "above";
  /** The caller shows it once; any action on the anchor dismisses it. */
  shown: boolean;
  onDismiss: () => void;
};

/** A one-line hint anchored to an element at the moment of first need. */
export function CoachTip({
  children,
  text,
  placement = "below",
  shown,
  onDismiss,
}: CoachTipProps) {
  const id = useId();
  return (
    <span className="sys-coach">
      {children}
      {shown ? (
        <span
          id={id}
          role="note"
          className={`sys-coach-tip sys-coach-tip--${placement}`}
        >
          <span>{text}</span>
          <button
            type="button"
            className="sys-icon-btn sys-coach-close"
            aria-label="Dismiss hint"
            onClick={onDismiss}
          >
            <span aria-hidden="true">×</span>
          </button>
        </span>
      ) : null}
    </span>
  );
}
