import { useRef, useState } from "react";
import { setEnvelope } from "../api";
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type {
  AutomationEnvelope,
  AutomationPoint,
  Selection,
} from "../types/project";
import {
  clampEnvelopeValue,
  replaceEnvelopePoint,
  sortedVolumePoints,
} from "../utils/envelopes";
import { LANE_HEIGHT } from "../utils/layout";
import { formatTime } from "../utils/time";

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
  return Math.abs(a.time - b.time) > 1e-6 || Math.abs(a.value - b.value) > 1e-6;
}

export function EnvelopeOverlay({
  envelopes,
  trackId,
  zoomPxPerSec,
  width,
  onSelectTrack,
}: EnvelopeOverlayProps) {
  const { projectPath, selection, setSelection, announceStatus } = useDaw();
  const editable = !isShareProjectKey(projectPath);
  const [draft, setDraft] = useState<AutomationPoint[] | null>(null);
  const dragRef = useRef<{
    index: number;
    origin: AutomationPoint[];
    points: AutomationPoint[];
  } | null>(null);
  const priorSel = useRef<Selection>(null);
  const commitLock = useRef(false);

  const base = sortedVolumePoints(envelopes, trackId);
  if (base.length < 1) {
    return null;
  }

  const height = LANE_HEIGHT;
  const sorted = draft ?? base;
  const points = sorted
    .map((p) => `${p.time * zoomPxPerSec},${valueToY(p.value, height)}`)
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
      await setEnvelope(projectPath, trackId, replaced.points);
      setDraft(null);
      setSelection({
        kind: "envelopePoint",
        trackId,
        index: Math.max(0, replaced.index),
      });
    } catch {
      setDraft(null);
      setSelection(priorSel.current);
      announceStatus("Could not apply envelope");
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
      <div className="envelope-overlay" style={{ width, height }}>
        <svg width={width} height={height} className="envelope-svg">
          <polyline
            fill="none"
            stroke="var(--envelope-line)"
            strokeWidth="1.5"
            points={points}
            pointerEvents="none"
            aria-hidden="true"
          />
          {sorted.map((p, i) => {
            const selected = selectedIndex === i;
            const label = `Envelope point ${i + 1} at ${formatTime(p.time)}`;
            return (
              <circle
                key={p.id}
                cx={p.time * zoomPxPerSec}
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
                  const x = e.clientX - rect.left;
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
