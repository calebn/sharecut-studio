import { useEffect, useRef, useState } from "react";
import { useMountedRef } from "../hooks/useMountedRef";
import type { AutomationPoint } from "../types/project";
import {
  clampEnvelopeValue,
  replaceEnvelopePoint,
  sameEnvelopePoint,
} from "../utils/envelopes";
import { formatTime } from "../utils/time";
import { VIEWPORT_CHUNK_PX } from "../utils/timelineViewport";
import { timelineTestIds } from "./selectors";

type EnvelopeDrag = {
  pointerId: number;
  target: SVGCircleElement;
  index: number;
  origin: AutomationPoint[];
  points: AutomationPoint[];
};

function releaseCapture(drag: EnvelopeDrag | null): void {
  if (drag?.target.hasPointerCapture?.(drag.pointerId)) {
    drag.target.releasePointerCapture(drag.pointerId);
  }
}

function valueToY(value: number, height: number): number {
  const clamped = clampEnvelopeValue(value);
  const norm = clamped / 1.5;
  return height - 4 - norm * (height - 8);
}

function yToValue(y: number, height: number): number {
  const t = (height - 4 - y) / (height - 8);
  return clampEnvelopeValue(t * 1.5);
}

function pointMoved(
  a: AutomationPoint | undefined,
  b: AutomationPoint | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return !sameEnvelopePoint(a, b);
}

/** Calls and clears a held release, if any; safe to call twice. */
function releaseHeld(ref: { current: (() => void) | null }): void {
  const release = ref.current;
  ref.current = null;
  release?.();
}

export interface EnvelopeOverlayViewProps {
  points: AutomationPoint[];
  zoomPxPerSec: number;
  width: number;
  height: number;
  visibleChunks: readonly [number, number];
  editable: boolean;
  selectedIndex: number | null;
  onSelectTrack: () => void;
  onSelectPoint: (index: number) => void;
  onCommitPoints: (
    points: AutomationPoint[],
    origin: AutomationPoint[],
  ) => Promise<unknown>;
  onCommitError: (error: unknown) => void;
  /**
   * Freezes the lane geometry and returns its release. Called inside
   * pointerdown so `height` cannot change before the first pointermove.
   */
  holdGeometry?: () => () => void;
}

/** Prop-driven envelope overlay used by the live adapter and the catalog. */
export function EnvelopeOverlayView({
  points,
  zoomPxPerSec,
  width,
  height,
  visibleChunks,
  editable,
  selectedIndex,
  onSelectTrack,
  onSelectPoint,
  onCommitPoints,
  onCommitError,
  holdGeometry,
}: EnvelopeOverlayViewProps) {
  const [draft, setDraft] = useState<AutomationPoint[] | null>(null);
  // Kept mounted outside the chunk range: unmounting would drop pointer
  // capture mid-drag or keyboard focus.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // By id, not index: a re-sort or delete keeps the focused circle (same key).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const dragRef = useRef<EnvelopeDrag | null>(null);
  const commitLock = useRef(false);

  const releaseHold = useRef<(() => void) | null>(null);
  // Post-await callbacks skip a view that unmounted mid-commit.
  const mounted = useMountedRef();
  useEffect(
    () => () => {
      const drag = dragRef.current;
      dragRef.current = null;
      releaseCapture(drag);
      releaseHeld(releaseHold);
    },
    [],
  );

  if (points.length < 1) {
    return null;
  }

  const [c0, c1] = visibleChunks;
  const sorted = draft ?? points;
  const x0 = c0 * VIEWPORT_CHUNK_PX;
  const x1 = Math.min(width, (c1 + 1) * VIEWPORT_CHUNK_PX);
  const xOf = (p: AutomationPoint) => p.time * zoomPxPerSec;
  // Points in the chunk, plus one each side so edge segments still draw.
  let first = sorted.findIndex((p) => xOf(p) >= x0);
  first = first < 0 ? sorted.length - 1 : Math.max(0, first - 1);
  let last = sorted.findIndex((p) => xOf(p) > x1);
  last = last < 0 ? sorted.length - 1 : last;
  const polyline = sorted
    .slice(first, last + 1)
    .map((p) => `${xOf(p) - x0},${valueToY(p.value, height)}`)
    .join(" ");

  const clearDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragIndex(null);
    setDraft(null);
    releaseCapture(drag);
    releaseHeld(releaseHold);
  };

  const commit = async (
    next: AutomationPoint[],
    dragIndex: number,
    origin: AutomationPoint[],
  ) => {
    const movedPoint = next[dragIndex];
    if (!movedPoint || !pointMoved(origin[dragIndex], movedPoint)) {
      setDraft(null);
      releaseHeld(releaseHold);
      onSelectPoint(dragIndex);
      return;
    }
    if (commitLock.current) {
      return;
    }
    const replaced = replaceEnvelopePoint(next, dragIndex, movedPoint);
    commitLock.current = true;
    try {
      await onCommitPoints(replaced.points, origin);
      // Unmounted mid-commit (track removed, Levels toggled off): skip the
      // selection write for a view that no longer exists.
      if (mounted.current) {
        setDraft(null);
        onSelectPoint(Math.max(0, replaced.index));
      }
    } catch (error) {
      if (mounted.current) {
        setDraft(null);
        onCommitError(error);
      }
    } finally {
      commitLock.current = false;
      releaseHeld(releaseHold);
    }
  };

  return (
    <>
      {/*
        Div (not button) so Lighthouse target-size ignores this full-lane hit —
        same pattern as lane-seek. Points below are named and keyboard-focusable.
      */}
      <div
        className="envelope-hit"
        role="presentation"
        onClick={(e) => {
          e.stopPropagation();
          onSelectTrack();
        }}
      />
      <div
        className="envelope-overlay"
        data-testid={timelineTestIds.envelope}
        style={{ left: x0, width: x1 - x0, height }}
      >
        <svg width={x1 - x0} height={height} className="envelope-svg">
          <polyline
            fill="none"
            stroke="var(--envelope-line)"
            strokeWidth="1.5"
            points={polyline}
            pointerEvents="none"
            aria-hidden="true"
          />
          {sorted.map((p, i) => {
            const pinned =
              i === dragIndex || i === selectedIndex || p.id === focusedId;
            if (!pinned && (xOf(p) < x0 || xOf(p) > x1)) {
              return null;
            }
            const selected = (dragIndex ?? selectedIndex) === i;
            const label = `Envelope point ${i + 1} at ${formatTime(p.time)}`;
            return (
              <circle
                key={p.id}
                cx={xOf(p) - x0}
                cy={valueToY(p.value, height)}
                r={selected ? 7 : editable ? 5 : 2.5}
                fill="var(--envelope-line)"
                className={selected ? "envelope-point-selected" : undefined}
                style={{ cursor: editable ? "grab" : "pointer" }}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={selected}
                onFocus={() => setFocusedId(p.id)}
                onBlur={(e) => {
                  setFocusedId((cur) => (cur === p.id ? null : cur));
                  if (dragRef.current?.target === e.currentTarget) clearDrag();
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "Escape" &&
                    dragRef.current?.target === e.currentTarget
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    clearDrag();
                    return;
                  }
                  if (e.key !== "Enter" && e.key !== " ") {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  if (!dragRef.current) onSelectPoint(i);
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  if (
                    dragRef.current ||
                    (e.pointerType === "mouse" && e.button !== 0)
                  )
                    return;
                  if (!editable) {
                    onSelectPoint(i);
                    return;
                  }
                  if (commitLock.current) return;
                  const target = e.currentTarget;
                  target.focus({ preventScroll: true });
                  if (document.activeElement !== target) return;
                  const copy = sorted.map((pt) => ({ ...pt }));
                  dragRef.current = {
                    pointerId: e.pointerId,
                    target,
                    index: i,
                    origin: copy.map((pt) => ({ ...pt })),
                    points: copy,
                  };
                  try {
                    releaseHold.current = holdGeometry?.() ?? null;
                    target.setPointerCapture?.(e.pointerId);
                    setDraft(copy);
                    setDragIndex(i);
                  } catch (error) {
                    clearDrag();
                    onCommitError(error);
                  }
                }}
                onPointerMove={(e) => {
                  const drag = dragRef.current;
                  if (!drag || drag.pointerId !== e.pointerId) return;
                  e.stopPropagation();
                  const svg = drag.target.ownerSVGElement;
                  if (!svg) {
                    return;
                  }
                  const rect = svg.getBoundingClientRect();
                  // The SVG starts at the chunk's x.
                  const x = e.clientX - rect.left + x0;
                  const y = e.clientY - rect.top;
                  const next = drag.points.map((pt, j) =>
                    j === drag.index
                      ? {
                          id: pt.id,
                          time: Math.max(0, x / zoomPxPerSec),
                          value: yToValue(y, height),
                        }
                      : pt,
                  );
                  dragRef.current = { ...drag, points: next };
                  setDraft(next);
                }}
                onPointerUp={(e) => {
                  const drag = dragRef.current;
                  if (!drag || drag.pointerId !== e.pointerId) return;
                  e.stopPropagation();
                  dragRef.current = null;
                  setDragIndex(null);
                  releaseCapture(drag);
                  void commit(drag.points, drag.index, drag.origin);
                }}
                onPointerCancel={(e) => {
                  if (dragRef.current?.pointerId !== e.pointerId) return;
                  e.stopPropagation();
                  clearDrag();
                }}
                onLostPointerCapture={(e) => {
                  if (dragRef.current?.pointerId === e.pointerId) clearDrag();
                }}
              />
            );
          })}
        </svg>
      </div>
    </>
  );
}
