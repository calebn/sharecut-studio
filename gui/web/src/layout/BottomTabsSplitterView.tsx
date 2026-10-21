import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  pxToRem,
  remToPx,
  type TabsHeightBounds,
} from "../hooks/useTabsHeight";
import { Button } from "../ui/Button";
import { useResizeObserver } from "../ui/useResizeObserver";

export interface BottomTabsSplitterViewProps {
  /** Current bottom-panel height in rem (stored preference or CSS default). */
  heightRem: number;
  minRem: number;
  maxRem: number;
  /** Live adapter reads fresh viewport policy; props-only shells use explicit bounds. */
  getPolicyBounds?: () => TabsHeightBounds;
  /**
   * Whether a stored preference exists, so the caller can restore it through
   * its resize policy after canceling an owned drag.
   */
  userSet: boolean;
  /** Requested height in rem; the live adapter clamps, persists and applies it. */
  onResize: (rem: number) => void;
  /** Clear the preference (double-click / Enter). */
  onReset: () => void;
  /**
   * Collapse the drawer to the tool rail: End, or a drag released more than
   * `COLLAPSE_OVERSHOOT_REM` below the minimum. The preference stays saved for
   * reopening; overshoot rollback goes through `onResize` and its resize policy.
   */
  onCollapse: () => void;
}

/** How far past the minimum a drag must pull before release collapses. */
export const COLLAPSE_OVERSHOOT_REM = 1.5;

interface PanelGeometry extends TabsHeightBounds {
  currentRem: number;
}

const GEOMETRY_EPSILON_PX = 0.5;

/** Props-only horizontal drag handle above the bottom Transcript/Comments/History tabs. */
export function BottomTabsSplitterView({
  heightRem,
  minRem,
  maxRem,
  getPolicyBounds,
  userSet,
  onResize,
  onReset,
  onCollapse,
}: BottomTabsSplitterViewProps) {
  const separatorRef = useRef<HTMLDivElement>(null);
  const remSignalRef = useRef<HTMLSpanElement>(null);
  const readGeometry = useCallback((): PanelGeometry => {
    const policy = getPolicyBounds?.() ?? { minRem, maxRem };
    const panel = separatorRef.current?.parentElement;
    const height = panel?.getBoundingClientRect().height ?? 0;
    const currentRem = height > 0 ? pxToRem(height) : heightRem;
    const shell = panel?.closest(".daw-shell");
    const main = shell?.querySelector(":scope > .daw-main");
    const mainHeight = main?.getBoundingClientRect().height ?? 0;
    const floor = shell
      ? getComputedStyle(shell)
          .getPropertyValue("--shell-main-min-height")
          .trim()
      : "";
    const capacity =
      mainHeight > 0 && floor.endsWith("rem")
        ? pxToRem(height + mainHeight) - Number.parseFloat(floor)
        : policy.maxRem;
    const maximum = Math.max(0, Math.min(policy.maxRem, capacity));
    return {
      currentRem,
      minRem: Math.min(currentRem, policy.minRem, maximum),
      maxRem: Math.max(currentRem, maximum),
    };
  }, [heightRem, minRem, maxRem, getPolicyBounds]);
  const [geometry, setGeometry] = useState<PanelGeometry>(() => ({
    currentRem: heightRem,
    minRem,
    maxRem,
  }));
  const measure = useCallback(() => {
    const next = readGeometry();
    setGeometry((prior) =>
      prior.currentRem === next.currentRem &&
      prior.minRem === next.minRem &&
      prior.maxRem === next.maxRem
        ? prior
        : next,
    );
  }, [readGeometry]);
  useLayoutEffect(measure, [measure, userSet]);
  useResizeObserver(
    [
      () => separatorRef.current?.parentElement,
      () => separatorRef.current?.closest(".daw-shell"),
      () =>
        separatorRef.current
          ?.closest(".daw-shell")
          ?.querySelector(":scope > .daw-main"),
      remSignalRef,
    ],
    measure,
  );

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
    /** Heights this drag has asked for; the prop can trail the latest by a render. */
    requested: Set<number>;
    collapse: boolean;
  } | null>(null);

  const stopListening = useRef<(() => void) | null>(null);

  const finish = useCallback((cancel: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    stopListening.current?.();
    stopListening.current = null;
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
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // The same pointer pressing again means its release was dropped; that
    // must not wedge every later drag. Another pointer's drag is left alone.
    if (dragRef.current?.pointerId === e.pointerId) finish(true);
    else if (dragRef.current) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const measured = readGeometry().currentRem;
    dragRef.current = {
      pointerId: e.pointerId,
      target: e.currentTarget,
      prior: { heightRem, userSet },
      painted: null,
      requested: new Set(),
      collapse: false,
      startY: e.clientY,
      startRem:
        Number.isFinite(measured) && measured > 0 ? measured : heightRem,
    };
    // Safari releases pointer capture mid-drag when the panel resizes under
    // it, so the drag follows the pointer on the window instead.
    const move = (ev: globalThis.PointerEvent) => onPointerMoveRef.current(ev);
    const up = (ev: globalThis.PointerEvent) => {
      if (dragRef.current?.pointerId === ev.pointerId) finish(false);
    };
    const cancel = (ev: globalThis.PointerEvent) => {
      if (dragRef.current?.pointerId === ev.pointerId) finish(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    stopListening.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  };

  const onPointerMoveRef = useRef<
    (e: { pointerId: number; clientY: number }) => void
  >(() => {});
  onPointerMoveRef.current = (e) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    // WebKit can deliver the next move before the prop catches up with the
    // last height this drag asked for. Only a height this drag never asked for
    // means something else resized the panel.
    const trailing =
      heightRem === drag.prior.heightRem || drag.requested.has(heightRem);
    if (!trailing) {
      finish(false);
      return;
    }
    if (
      heightRem === (drag.painted ?? drag.prior.heightRem) &&
      userSet !== (drag.painted !== null || drag.prior.userSet)
    ) {
      finish(false);
      return;
    }
    const dy = drag.startY - e.clientY;
    const raw = pxToRem(remToPx(drag.startRem) + dy);
    const bounds = readGeometry();
    const collapse = raw < bounds.minRem - COLLAPSE_OVERSHOOT_REM;
    if (collapse !== drag.collapse) {
      drag.collapse = collapse;
      setCollapseArmed(collapse);
    }
    const next = Math.min(bounds.maxRem, Math.max(bounds.minRem, raw));
    if (next === (drag.painted ?? drag.startRem)) return;
    drag.painted = next;
    drag.requested.add(next);
    onResize(next);
  };

  const resizeTo = (target: number, bounds: PanelGeometry) => {
    const next = Math.min(bounds.maxRem, Math.max(bounds.minRem, target));
    if (Math.abs(next - bounds.currentRem) > pxToRem(GEOMETRY_EPSILON_PX))
      onResize(next);
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
    const bounds = readGeometry();
    const base = bounds.currentRem;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      resizeTo(base + step, bounds);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      resizeTo(base - step, bounds);
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      resizeTo(bounds.maxRem, bounds);
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

  const valueNow = Math.round(geometry.currentRem * 10) / 10;
  const epsilon = pxToRem(GEOMETRY_EPSILON_PX);
  const suppressClickRef = useRef(false);
  const stepPanel = (delta: number) => {
    if (dragRef.current) return;
    const bounds = readGeometry();
    resizeTo(bounds.currentRem + delta, bounds);
  };
  return (
    <>
      <div
        ref={separatorRef}
        className="bottom-tabs-splitter"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor panels"
        aria-valuemin={Math.round(geometry.minRem * 10) / 10}
        aria-valuemax={Math.round(geometry.maxRem * 10) / 10}
        aria-valuenow={valueNow}
        aria-valuetext={
          collapseArmed ? "Release to collapse" : `${valueNow} rem`
        }
        data-collapse-armed={collapseArmed ? "" : undefined}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onBlur={() => finish(true)}
        onDoubleClick={() => {
          if (!dragRef.current) onReset();
        }}
        onKeyDown={onKeyDown}
        title="Drag or arrows to resize · Shift for larger steps · End or drag past the bottom collapses · Escape cancels · Enter or double-click resets"
      >
        <span className="bottom-tabs-splitter-grip" aria-hidden />
        <span ref={remSignalRef} className="splitter-rem-signal" aria-hidden />
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
            geometry.currentRem <= geometry.minRem + epsilon
              ? "Panel is at its shortest size."
              : undefined
          }
          onClick={() => stepPanel(-1)}
        >
          Shorter
        </Button>
        <Button
          disabledReason={
            geometry.currentRem >= geometry.maxRem - epsilon
              ? "Panel is at its tallest size."
              : undefined
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
