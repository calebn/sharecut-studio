import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { pxToRem, remToPx } from "../hooks/useTabsHeight";
import { Button } from "../ui/Button";
import { useResizeObserver } from "../ui/useResizeObserver";

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
  /**
   * Collapse the drawer to the tool rail: End, or a drag released more than
   * `COLLAPSE_OVERSHOOT_REM` below the minimum. The stored height stays, so
   * reopening returns to it.
   */
  onCollapse: () => void;
}

/** How far past the minimum a drag must pull before release collapses. */
export const COLLAPSE_OVERSHOOT_REM = 1.5;

/** Props-only horizontal drag handle above the bottom Transcript/Comments/History tabs. */
export function BottomTabsSplitterView({
  heightRem,
  minRem,
  maxRem,
  userSet,
  onResize,
  onReset,
  onCollapse,
}: BottomTabsSplitterViewProps) {
  const separatorRef = useRef<HTMLDivElement>(null);
  const [measuredRem, setMeasuredRem] = useState<number | null>(null);
  const measure = useCallback(() => {
    const height =
      separatorRef.current?.parentElement?.getBoundingClientRect().height;
    setMeasuredRem(
      height != null && Number.isFinite(height) && height > 0
        ? pxToRem(height)
        : null,
    );
  }, []);
  useLayoutEffect(measure, [measure, heightRem, userSet]);
  useResizeObserver(() => separatorRef.current?.parentElement, measure);

  const [collapseArmed, setCollapseArmed] = useState(false);
  const latest = useRef({ heightRem, userSet, onResize, onReset, onCollapse });
  latest.current = { heightRem, userSet, onResize, onReset, onCollapse };
  const dragRef = useRef<{
    pointerId: number;
    target: HTMLDivElement;
    startY: number;
    startRem: number;
    prior: { heightRem: number; userSet: boolean };
    painted: number | null;
    collapse: boolean;
  } | null>(null);

  const finish = useCallback((cancel: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setCollapseArmed(false);
    const current = latest.current;
    const collapse = !cancel && drag.collapse;
    if (
      drag.painted !== null &&
      current.userSet &&
      current.heightRem === drag.painted &&
      (cancel || collapse || drag.painted === drag.startRem)
    ) {
      if (drag.prior.userSet) current.onResize(drag.prior.heightRem);
      else current.onReset();
    }
    if (drag.target.hasPointerCapture?.(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
    if (collapse) current.onCollapse();
  }, []);

  useEffect(() => () => finish(true), [finish]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current || (e.pointerType === "mouse" && e.button !== 0))
      return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const panel = e.currentTarget.parentElement;
    const measured = panel
      ? pxToRem(panel.getBoundingClientRect().height)
      : heightRem;
    dragRef.current = {
      pointerId: e.pointerId,
      target: e.currentTarget,
      prior: { heightRem, userSet },
      painted: null,
      collapse: false,
      startY: e.clientY,
      startRem:
        Number.isFinite(measured) && measured > 0 ? measured : heightRem,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (
      heightRem !== (drag.painted ?? drag.prior.heightRem) ||
      userSet !== (drag.painted !== null || drag.prior.userSet)
    ) {
      finish(false);
      return;
    }
    const dy = drag.startY - e.clientY;
    const raw = pxToRem(remToPx(drag.startRem) + dy);
    const collapse = raw < minRem - COLLAPSE_OVERSHOOT_REM;
    if (collapse !== drag.collapse) {
      drag.collapse = collapse;
      setCollapseArmed(collapse);
    }
    const next = Math.min(maxRem, Math.max(minRem, raw));
    if (next === (drag.painted ?? drag.startRem)) return;
    drag.painted = next;
    onResize(next);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) finish(false);
  };
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) finish(true);
  };

  const panelHeightRem = (el: HTMLDivElement): number => {
    const panel = el.parentElement;
    const measured = panel
      ? pxToRem(panel.getBoundingClientRect().height)
      : heightRem;
    return Number.isFinite(measured) && measured > 0 ? measured : heightRem;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      if (
        ["Escape", "ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(
          e.key,
        )
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") finish(true);
      }
      return;
    }
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
      onCollapse();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onReset();
    }
  };

  const valueNow = Math.round((measuredRem ?? heightRem) * 10) / 10;
  const currentRem = userSet ? heightRem : (measuredRem ?? heightRem);

  const suppressClickRef = useRef(false);
  const stepPanel = (delta: number) => {
    if (dragRef.current) return;
    const base = userSet
      ? heightRem
      : separatorRef.current
        ? panelHeightRem(separatorRef.current)
        : heightRem;
    const next = Math.min(maxRem, Math.max(minRem, base + delta));
    if (next !== base) onResize(next);
  };
  return (
    <>
      <div
        ref={separatorRef}
        className="bottom-tabs-splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor panels"
        aria-valuemin={minRem}
        aria-valuemax={Math.round(maxRem * 10) / 10}
        aria-valuenow={valueNow}
        aria-valuetext={
          collapseArmed ? "Release to collapse" : `${valueNow} rem`
        }
        data-collapse-armed={collapseArmed ? "" : undefined}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onBlur={() => finish(true)}
        onDoubleClick={() => {
          if (!dragRef.current) onReset();
        }}
        onKeyDown={onKeyDown}
        title="Drag or arrows to resize · Shift for larger steps · End or drag past the bottom collapses · Escape cancels · Enter or double-click resets"
      >
        <span className="bottom-tabs-splitter-grip" aria-hidden />
      </div>
      <div
        className="panel-size-controls"
        role="group"
        aria-label="Panel size"
        onClickCapture={(event) => {
          if (suppressClickRef.current || dragRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onPointerDownCapture={(event) => {
          suppressClickRef.current = Boolean(dragRef.current);
          if (dragRef.current) {
            event.preventDefault();
            event.stopPropagation();
            finish(true);
          }
        }}
      >
        <Button
          disabledReason={
            currentRem <= minRem ? "Panel is at its shortest size." : undefined
          }
          onClick={() => stepPanel(-1)}
        >
          Shorter
        </Button>
        <Button
          disabledReason={
            currentRem >= maxRem ? "Panel is at its tallest size." : undefined
          }
          onClick={() => stepPanel(1)}
        >
          Taller
        </Button>
        <Button
          onClick={() => {
            if (!dragRef.current) onReset();
          }}
        >
          Reset panel size
        </Button>
      </div>
    </>
  );
}
