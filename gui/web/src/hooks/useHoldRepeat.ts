import { type MouseEvent, type PointerEvent, useEffect, useRef } from "react";
import { nudgeRepeatDelayMs } from "./gestureConstants";

/** Marks a hold-to-repeat control; `layout.css` keeps native text selection off it. */
export const HOLD_REPEAT_CLASS = "hold-repeat";

/**
 * Hold-to-repeat for a step button, with the nudge timing (`nudgeRepeatDelayMs`).
 * A press steps once; a press held past the long-press hold repeats, faster
 * after a few steps, until `step` reports it cannot go on, the finger lifts or
 * leaves, or the button loses focus. A keyboard activation steps once per
 * click. A pointer's click (`detail` above 0) follows its press, so it is not
 * a second step.
 */
export function useHoldRepeat(step: () => boolean) {
  const stepRef = useRef(step);
  stepRef.current = step;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const repeatLater = (repeats: number) => {
    timer.current = setTimeout(() => {
      if (!stepRef.current()) {
        stop();
        return;
      }
      repeatLater(repeats + 1);
    }, nudgeRepeatDelayMs(repeats));
  };

  useEffect(() => stop, []);

  return {
    className: HOLD_REPEAT_CLASS,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || event.currentTarget.disabled) return;
      stop();
      if (stepRef.current()) repeatLater(0);
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onBlur: stop,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0) stepRef.current();
    },
  };
}
