import { useEffect, useRef, useState } from "react";
import type { AutomationPoint } from "../types/project";
import {
  clampEnvelopeValue,
  replaceEnvelopePoint,
  sameEnvelopePoint,
} from "../utils/envelopes";
import { formatTime } from "../utils/time";
import { VIEWPORT_CHUNK_PX } from "../utils/timelineViewport";

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
  const dragRef = useRef<{
    index: number;
    origin: AutomationPoint[];
    points: AutomationPoint[];
  } | null>(null);
  const commitLock = useRef(false);

  const releaseHold = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseHeld(releaseHold);
    };
  }, []);

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
    dragRef.current = null;
    setDragIndex(null);
    setDraft(null);
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
            const selected = selectedIndex === i;
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
                onBlur={() =>
                  setFocusedId((cur) => (cur === p.id ? null : cur))
                }
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  onSelectPoint(i);
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onSelectPoint(i);
                  if (!editable || commitLock.current) {
                    return;
                  }
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  // Freeze lane geometry now, not an effect later: yToValue
                  // maps every pointermove through `height`.
                  releaseHeld(releaseHold);
                  releaseHold.current = holdGeometry?.() ?? null;
                  const copy = sorted.map((pt) => ({ ...pt }));
                  dragRef.current = {
                    index: i,
                    origin: copy.map((pt) => ({ ...pt })),
                    points: copy,
                  };
                  setDraft(copy);
                  setDragIndex(i);
                }}
                onPointerMove={(e) => {
                  if (!dragRef.current) {
                    return;
                  }
                  e.stopPropagation();
                  const svg = (e.target as SVGElement).ownerSVGElement;
                  if (!svg) {
                    return;
                  }
                  const rect = svg.getBoundingClientRect();
                  // The SVG starts at the chunk's x.
                  const x = e.clientX - rect.left + x0;
                  const y = e.clientY - rect.top;
                  const next = dragRef.current.points.map((pt, j) =>
                    j === dragRef.current!.index
                      ? {
                          id: pt.id,
                          time: Math.max(0, x / zoomPxPerSec),
                          value: yToValue(y, height),
                        }
                      : pt,
                  );
                  dragRef.current = { ...dragRef.current, points: next };
                  setDraft(next);
                }}
                onPointerUp={(e) => {
                  if (!dragRef.current) {
                    return;
                  }
                  e.stopPropagation();
                  const { index, points: next, origin } = dragRef.current;
                  dragRef.current = null;
                  setDragIndex(null);
                  void commit(next, index, origin);
                }}
                onPointerCancel={(e) => {
                  e.stopPropagation();
                  clearDrag();
                }}
                onLostPointerCapture={() => {
                  if (dragRef.current) {
                    clearDrag();
                  }
                }}
              />
            );
          })}
        </svg>
      </div>
    </>
  );
}
