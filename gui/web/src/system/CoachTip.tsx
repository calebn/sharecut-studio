import { type ReactNode, useRef } from "react";
import { SystemIcon } from "./SystemIcon";

export type CoachTipProps = {
  /** The element the hint points at. */
  children: ReactNode;
  /** One line. */
  text: string;
  placement?: "below" | "above";
  /** The tip anchors to the nearest positioned ancestor, for an anchor too far from the edge to fit it. */
  edge?: boolean;
  /** The caller shows it once. */
  shown: boolean;
  /** Called by the close button and by any click or key activation on the anchor. */
  onDismiss: () => void;
};

/** A one-line hint anchored to an element at the moment of first need. */
export function CoachTip({
  children,
  text,
  placement = "below",
  edge = false,
  shown,
  onDismiss,
}: CoachTipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  // The close button unmounts with the tip; hand focus back to the anchor.
  const dismissFromClose = () => {
    const target =
      anchorRef.current?.querySelector<HTMLElement>(
        "button, a[href], input, select, textarea",
      ) ?? anchorRef.current;
    target?.focus({ preventScroll: true });
    onDismiss();
  };
  return (
    <span className={edge ? "sys-coach sys-coach--edge" : "sys-coach"}>
      {/* Capture, so the anchor's own handler still runs. Not an interactive role: it only listens. */}
      <span
        ref={anchorRef}
        tabIndex={-1}
        className="sys-coach-anchor"
        onClickCapture={shown ? onDismiss : undefined}
      >
        {children}
      </span>
      {shown ? (
        <span
          role="note"
          className={`sys-coach-tip sys-coach-tip--${placement}`}
        >
          <span>{text}</span>
          <button
            type="button"
            className="sys-icon-btn sys-coach-close"
            aria-label="Dismiss hint"
            title="Dismiss hint"
            onClick={dismissFromClose}
          >
            <SystemIcon name="x" size={16} />
          </button>
        </span>
      ) : null}
    </span>
  );
}
