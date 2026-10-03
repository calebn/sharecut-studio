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

  const latest = useRef({ heightRem, userSet, onResize, onReset });
  latest.current = { heightRem, userSet, onResize, onReset };
  const dragRef = useRef<{
    pointerId: number;
    target: HTMLDivElement;
    startY: number;
    startRem: number;
    prior: { heightRem: number; userSet: boolean };
    painted: number | null;
  } | null>(null);

  const finish = useCallback((cancel: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const current = latest.current;
    if (
      drag.painted !== null &&
      current.userSet &&
      current.heightRem === drag.painted &&
      (cancel || drag.painted === drag.startRem)
    ) {
      if (drag.prior.userSet) current.onResize(drag.prior.heightRem);
      else current.onReset();
    }
    if (drag.target.hasPointerCapture?.(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
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
    const next = Math.min(
      maxRem,
      Math.max(minRem, pxToRem(remToPx(drag.startRem) + dy)),
    );
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
      onResize(minRem);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      onReset();
    }
  };

  const valueNow = Math.round((measuredRem ?? heightRem) * 10) / 10;

  return (
    <div
      ref={separatorRef}
      className="bottom-tabs-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor panels"
      aria-valuemin={minRem}
      aria-valuemax={Math.round(maxRem * 10) / 10}
      aria-valuenow={valueNow}
      aria-valuetext={`${valueNow} rem`}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onBlur={() => finish(true)}
      onDoubleClick={() => onReset()}
      onKeyDown={onKeyDown}
      title="Drag or arrows to resize · Shift for larger steps · Escape cancels · Enter or double-click resets"
    >
      <span className="bottom-tabs-splitter-grip" aria-hidden />
    </div>
  );
}
