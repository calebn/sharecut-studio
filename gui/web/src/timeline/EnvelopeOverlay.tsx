import { useCallback, useRef, useState } from "react";
import { setEnvelope } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type {
  AutomationEnvelope,
  AutomationPoint,
  Selection,
} from "../types/project";
import { errorMessage } from "../utils/apiError";
import {
  clampEnvelopeValue,
  replaceEnvelopePoint,
  sameEnvelopePoint,
  sortedVolumePoints,
} from "../utils/envelopes";
import { formatTime } from "../utils/time";
import {
  VIEWPORT_CHUNK_PX,
  viewportChunkRange,
} from "../utils/timelineViewport";
import { useHoldTimelineMetrics, useTimelineMetrics } from "./timelineMetrics";

interface EnvelopeOverlayProps {
  envelopes: AutomationEnvelope[];
  trackId: string;
  zoomPxPerSec: number;
  width: number;
  onSelectTrack: () => void;
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

export function EnvelopeOverlay({
  envelopes,
  trackId,
  zoomPxPerSec,
  width,
  onSelectTrack,
}: EnvelopeOverlayProps) {
  const { projectPath, selection, setSelection, announceStatus } = useDaw(
    (s) => ({
      projectPath: s.projectPath,
      selection: s.selection,
      setSelection: s.setSelection,
      announceStatus: s.announceStatus,
    }),
  );
  const { laneHeight } = useTimelineMetrics();
  // Only the chunks on screen: the lane can be millions of px wide.
  const chunks = useDawStore(
    useCallback(
      (s: { scrollLeft: number; timelineViewportWidth: number }) =>
        viewportChunkRange(s.scrollLeft, s.timelineViewportWidth, width).join(
          ":",
        ),
      [width],
    ),
  );
  const editable = !isShareProjectKey(projectPath);
  const [draft, setDraft] = useState<AutomationPoint[] | null>(null);
  const dragRef = useRef<{
    index: number;
    origin: AutomationPoint[];
    points: AutomationPoint[];
  } | null>(null);
  const priorSel = useRef<Selection>(null);
  const commitLock = useRef(false);
  // yToValue uses the lane height and SVG rect: keep both still mid-drag.
  useHoldTimelineMetrics(draft != null);

  const base = sortedVolumePoints(envelopes, trackId);
  if (base.length < 1) {
    return null;
  }

  const height = laneHeight;
  const sorted = draft ?? base;
  const [c0 = 0, c1 = 0] = chunks.split(":").map(Number);
  const x0 = c0 * VIEWPORT_CHUNK_PX;
  const x1 = Math.min(width, (c1 + 1) * VIEWPORT_CHUNK_PX);
  const xOf = (p: AutomationPoint) => p.time * zoomPxPerSec;
  // Points in the chunk, plus one each side so edge segments still draw.
  let first = sorted.findIndex((p) => xOf(p) >= x0);
  first = first < 0 ? sorted.length - 1 : Math.max(0, first - 1);
  let last = sorted.findIndex((p) => xOf(p) > x1);
  last = last < 0 ? sorted.length - 1 : last;
  const points = sorted
    .slice(first, last + 1)
    .map((p) => `${xOf(p) - x0},${valueToY(p.value, height)}`)
    .join(" ");
  const selectedIndex =
    selection?.kind === "envelopePoint" && selection.trackId === trackId
      ? selection.index
      : null;

  const selectPoint = (index: number) => {
    setSelection({ kind: "envelopePoint", trackId, index });
  };

  const clearDrag = () => {
    dragRef.current = null;
    setDraft(null);
  };

  const commit = async (
    next: AutomationPoint[],
    dragIndex: number,
    origin: AutomationPoint[],
  ) => {
    const movedPoint = next[dragIndex];
    if (!movedPoint || !pointMoved(origin[dragIndex], movedPoint)) {
      setDraft(null);
      return;
    }
    if (commitLock.current) {
      return;
    }
    const replaced = replaceEnvelopePoint(next, dragIndex, movedPoint);
    commitLock.current = true;
    try {
      await setEnvelope(projectPath, trackId, replaced.points, origin);
      setDraft(null);
      setSelection({
        kind: "envelopePoint",
        trackId,
        index: Math.max(0, replaced.index),
      });
    } catch (error) {
      setDraft(null);
      setSelection(priorSel.current);
      announceStatus(errorMessage(error, "Could not apply envelope"));
    } finally {
      commitLock.current = false;
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
            points={points}
            pointerEvents="none"
            aria-hidden="true"
          />
          {sorted.map((p, i) => {
            if (xOf(p) < x0 || xOf(p) > x1) {
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
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  selectPoint(i);
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  priorSel.current = selection;
                  selectPoint(i);
                  if (!editable || commitLock.current) {
                    return;
                  }
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  const copy = sorted.map((pt) => ({ ...pt }));
                  dragRef.current = {
                    index: i,
                    origin: copy.map((pt) => ({ ...pt })),
                    points: copy,
                  };
                  setDraft(copy);
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
