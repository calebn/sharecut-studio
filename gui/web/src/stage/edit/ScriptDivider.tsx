import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { remToPx } from "../../utils/remToPx";
import { SCRIPT_WIDTH_MAX_REM, SCRIPT_WIDTH_MIN_REM } from "./useScriptSize";

export interface ScriptDividerProps {
  /** The Script pane's width in rem; it sits on the inline end. */
  widthRem: number;
  onResize: (rem: number) => void;
  onReset: () => void;
}

const STEP_REM = 1;
const BIG_STEP_REM = 4;

/**
 * The plain divider between the timeline and the Script pane. Drag it, press
 * the arrows (1 rem, Shift 4 rem), Home or End (smallest or largest), or Enter
 * or double-click to reset. It has no text buttons.
 */
export function ScriptDivider({
  widthRem,
  onResize,
  onReset,
}: ScriptDividerProps) {
  const drag = useRef<{ x: number; rem: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, rem: widthRem };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    onResize(start.rem - (e.clientX - start.x) / remToPx(1));
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP_REM : STEP_REM;
    // The divider moves with the arrow, so the pane on its right grows leftward.
    if (e.key === "ArrowLeft") onResize(widthRem + step);
    else if (e.key === "ArrowRight") onResize(widthRem - step);
    else if (e.key === "Home") onResize(SCRIPT_WIDTH_MIN_REM);
    else if (e.key === "End") onResize(SCRIPT_WIDTH_MAX_REM);
    else if (e.key === "Enter") onReset();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className="script-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Script"
      aria-valuemin={SCRIPT_WIDTH_MIN_REM}
      aria-valuemax={SCRIPT_WIDTH_MAX_REM}
      aria-valuenow={Math.round(widthRem * 10) / 10}
      aria-valuetext={`${Math.round(widthRem * 10) / 10} rem`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      title="Drag or use the arrow keys to resize · Enter or double-click resets"
    >
      <span className="script-divider-grip" aria-hidden="true" />
    </div>
  );
}
