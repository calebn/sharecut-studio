import type { CSSProperties, Ref } from "react";
import { SystemIcon } from "./SystemIcon";

export type CoachTipBubbleProps = {
  text: string;
  placement?: "below" | "above";
  onClose: () => void;
  className?: string;
  /** Position for a bubble pointing at a spot, not at a wrappable element. */
  style?: CSSProperties;
  ref?: Ref<HTMLSpanElement>;
};

/** The note and its close button. CoachTip wraps an anchor in one; a spot that cannot be wrapped renders it directly. */
export function CoachTipBubble({
  text,
  placement = "below",
  onClose,
  className,
  style,
  ref,
}: CoachTipBubbleProps) {
  return (
    <span
      ref={ref}
      role="note"
      className={`sys-coach-tip sys-coach-tip--${placement}${className ? ` ${className}` : ""}`}
      style={style}
    >
      <span>{text}</span>
      <button
        type="button"
        className="sys-icon-btn sys-coach-close"
        aria-label="Dismiss hint"
        title="Dismiss hint"
        onClick={onClose}
      >
        <SystemIcon name="x" size={16} />
      </button>
    </span>
  );
}
