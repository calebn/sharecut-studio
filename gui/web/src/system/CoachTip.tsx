import { type ReactNode, useEffect, useEffectEvent, useRef } from "react";
import { CoachTipBubble } from "./CoachTipBubble";

/** What a view needs to render one tip it does not own. */
export type CoachHint = {
  text: string;
  shown: boolean;
  onDismiss: () => void;
  /** Free the slot, keeping the tip unseen, when its target is gone. */
  onRelease?: () => void;
};

export type CoachTipProps = {
  /** The element the hint points at. */
  children: ReactNode;
  /** One line. */
  text: string;
  placement?: "below" | "above";
  /** Which end of the anchor the tip lines up with. `end` for an anchor near the inline-end edge. */
  align?: "start" | "end";
  /** The tip anchors to the nearest positioned ancestor, for an anchor too far from the edge to fit it. */
  edge?: boolean;
  /** The caller shows it once. */
  shown: boolean;
  /** Called by the close button and by any click or key activation on the anchor. */
  onDismiss?: () => void;
  /** Called by a press on the bubble itself, which the close button and the anchor do not cover. */
  onPress?: () => void;
};

/** A one-line hint anchored to an element at the moment of first need. */
export function CoachTip({
  children,
  text,
  placement = "below",
  align = "start",
  edge = false,
  shown,
  onDismiss,
  onPress,
}: CoachTipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const pressed = useEffectEvent((event: MouseEvent) => {
    if (!(event.target as Element).closest(".sys-coach-close")) onPress?.();
  });
  // A click, not a pointerdown: the bubble stays under the finger for the whole
  // press, so nothing beneath it is hit. A listener on the note itself, which
  // has no role to press, keeps the accessibility lint's rules for controls.
  const pressable = onPress !== undefined;
  useEffect(() => {
    const bubble = bubbleRef.current;
    if (!shown || !bubble || !pressable) return;
    const listener = (event: MouseEvent) => pressed(event);
    bubble.addEventListener("click", listener);
    return () => bubble.removeEventListener("click", listener);
  }, [shown, pressable]);
  // The close button unmounts with the tip; hand focus back to the anchor.
  const dismissFromClose = () => {
    const target =
      anchorRef.current?.querySelector<HTMLElement>(
        "button, a[href], input, select, textarea",
      ) ?? anchorRef.current;
    target?.focus({ preventScroll: true });
    onDismiss?.();
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
        <CoachTipBubble
          ref={bubbleRef}
          text={text}
          placement={placement}
          className={align === "end" ? "sys-coach-tip--end" : undefined}
          onClose={dismissFromClose}
        />
      ) : null}
    </span>
  );
}
