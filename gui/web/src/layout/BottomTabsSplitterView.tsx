import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import {
  DEFAULT_TABS_HEIGHT_REM,
  pxToRem,
  remToPx,
} from "../hooks/useTabsHeight";

export interface BottomTabsSplitterViewProps {
  /** Current bottom-panel height in rem (stored preference or CSS default). */
  heightRem: number;
  minRem: number;
  maxRem: number;
  /**
   * Whether a stored preference exists. Without one, keyboard steps start from
   * the measured parent panel, since CSS decides the default height.
   */
  userSet: boolean;
  /** Requested height in rem; the live adapter clamps, persists and applies it. */
  onResize: (rem: number) => void;
  /** Clear the preference (double-click / Enter). */
  onReset: () => void;
}

/** Props-only horizontal drag handle above the bottom Transcript/Comments/History tabs. */
export function BottomTabsSplitterView({
  heightRem,
  minRem,
  maxRem,
  userSet,
  onResize,
  onReset,
}: BottomTabsSplitterViewProps) {
  const dragRef = useRef<{
    startY: number;
    startRem: number;
  } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const panel = e.currentTarget.parentElement;
    const measured = panel
      ? pxToRem(panel.getBoundingClientRect().height)
      : heightRem;
    dragRef.current = {
      startY: e.clientY,
      startRem:
        Number.isFinite(measured) && measured > 0 ? measured : heightRem,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const dy = drag.startY - e.clientY;
    onResize(pxToRem(remToPx(drag.startRem) + dy));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const panelHeightRem = (el: HTMLDivElement): number => {
    const panel = el.parentElement;
    const measured = panel
      ? pxToRem(panel.getBoundingClientRect().height)
      : heightRem;
    return Number.isFinite(measured) && measured > 0 ? measured : heightRem;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 1 : 0.25;
    const base = userSet ? heightRem : panelHeightRem(e.currentTarget);
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      onResize(base + step);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      onResize(base - step);
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      onResize(maxRem);
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      onResize(minRem);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onReset();
    }
  };

  const valueNow = Math.round(heightRem * 10) / 10;

  return (
    <div
      className="bottom-tabs-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor panels"
      aria-valuemin={minRem}
      aria-valuemax={Math.round(maxRem * 10) / 10}
      aria-valuenow={valueNow}
      aria-valuetext={`${valueNow} rem (default ${DEFAULT_TABS_HEIGHT_REM})`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onReset()}
      onKeyDown={onKeyDown}
      title="Drag to resize · double-click to reset"
    >
      <span className="bottom-tabs-splitter-grip" aria-hidden />
    </div>
  );
}
