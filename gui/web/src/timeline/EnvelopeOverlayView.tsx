import { useEffect, useRef, useState } from "react";
import { useMountedRef } from "../hooks/useMountedRef";
import type { AutomationPoint } from "../types/project";
import {
  clampEnvelopeValue,
  ENVELOPE_POINT_EPSILON,
  replaceEnvelopePoint,
  sameEnvelopePoint,
  sameEnvelopePoints,
} from "../utils/envelopes";
import { formatTime } from "../utils/time";
import { VIEWPORT_CHUNK_PX } from "../utils/timelineViewport";
import { HIT_SURFACE_PROPS, hitTargetProps } from "./hitTargets";
import { timelineTestIds } from "./selectors";

type EnvelopeDrag = {
  pointerId: number;
  selectPoint: (pointId: string) => void;
  target: SVGCircleElement;
  pointId: string;
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
  baselinePoints: readonly AutomationPoint[];
  zoomPxPerSec: number;
  width: number;
  height: number;
  visibleChunks: readonly [number, number];
  editable: boolean;
  selectedPointId: string | null;
  onSelectTrack: () => void;
  captureSelection: () => (pointId: string) => void;
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
  baselinePoints,
  zoomPxPerSec,
  width,
  height,
  visibleChunks,
  editable,
  selectedPointId,
  onSelectTrack,
  captureSelection,
  onCommitPoints,
  onCommitError,
  holdGeometry,
}: EnvelopeOverlayViewProps) {
  const [draft, setDraft] = useState<AutomationPoint[] | null>(null);
  // Kept mounted outside the chunk range: unmounting would drop pointer
  // capture mid-drag or keyboard focus.
  const [dragPointId, setDragPointId] = useState<string | null>(null);
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

  useEffect(() => {
    const drag = dragRef.current;
    if (!drag || sameEnvelopePoints(drag.origin, baselinePoints)) return;
    dragRef.current = null;
    releaseCapture(drag);
    releaseHeld(releaseHold);
    setDraft(null);
    setDragPointId(null);
  }, [baselinePoints]);

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
    setDragPointId(null);
    setDraft(null);
    releaseCapture(drag);
    releaseHeld(releaseHold);
  };

  const commit = async (
    next: AutomationPoint[],
    pointId: string,
    origin: AutomationPoint[],
    selectPoint: (pointId: string) => void,
  ) => {
    const movedPoint = next.find((point) => point.id === pointId);
    if (
      !movedPoint ||
      !pointMoved(
        origin.find((point) => point.id === pointId),
        movedPoint,
      )
    ) {
      setDraft(null);
      releaseHeld(releaseHold);
      selectPoint(pointId);
      return;
    }
    if (commitLock.current) {
      return;
    }
    const originalPoint = origin.find((point) => point.id === pointId);
    if (
      originalPoint?.time !== movedPoint.time &&
      next.some(
        (point) =>
          point.id !== pointId &&
          Math.abs(point.time - movedPoint.time) <= ENVELOPE_POINT_EPSILON,
      )
    ) {
      setDraft(null);
      releaseHeld(releaseHold);
      onCommitError(
        new Error(
          "A point already exists at this time. Choose a different time.",
        ),
      );
      return;
    }
    const replaced = replaceEnvelopePoint(next, movedPoint);
    commitLock.current = true;
    try {
      await onCommitPoints(replaced, origin);
      // Unmounted mid-commit (track removed, Levels toggled off): skip the
      // selection write for a view that no longer exists.
      if (mounted.current) {
        setDraft(null);
        selectPoint(pointId);
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
        {...HIT_SURFACE_PROPS}
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
              p.id === dragPointId ||
              p.id === selectedPointId ||
              p.id === focusedId;
            if (!pinned && (xOf(p) < x0 || xOf(p) > x1)) {
              return null;
            }
            const selected = (dragPointId ?? selectedPointId) === p.id;
            const label = `Envelope point ${i + 1} at ${formatTime(p.time)}`;
            return (
              <circle
                key={p.id}
                cx={xOf(p) - x0}
                cy={valueToY(p.value, height)}
                r={selected ? 7 : editable ? 5 : 2.5}
                fill="var(--envelope-line)"
                className={selected ? "envelope-point-selected" : undefined}
                {...hitTargetProps("envelope-point", p.id, p.time, {
                  selected,
                  detail: p.value.toFixed(2),
                })}
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
                  if (!dragRef.current) captureSelection()(p.id);
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
                    captureSelection()(p.id);
                    return;
                  }
                  if (commitLock.current) return;
                  const target = e.currentTarget;
                  target.focus({ preventScroll: true });
                  if (document.activeElement !== target) return;
                  const copy = sorted.map((pt) => ({ ...pt }));
                  dragRef.current = {
                    pointerId: e.pointerId,
                    selectPoint: captureSelection(),
                    target,
                    pointId: p.id,
                    origin: baselinePoints.map((pt) => ({ ...pt })),
                    points: copy,
                  };
                  try {
                    releaseHold.current = holdGeometry?.() ?? null;
                    target.setPointerCapture?.(e.pointerId);
                    setDraft(copy);
                    setDragPointId(p.id);
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
                  const next = drag.points.map((pt) =>
                    pt.id === drag.pointId
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
                  setDragPointId(null);
                  releaseCapture(drag);
                  void commit(
                    drag.points,
                    drag.pointId,
                    drag.origin,
                    drag.selectPoint,
                  );
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
