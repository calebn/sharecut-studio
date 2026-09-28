import { useRef, useState } from "react";
import { isHandleDrag } from "../edit/dragThreshold";
import type { PendingEditView } from "../types/project";
import { pendingEditTrackIds } from "../utils/edits";
import {
  pendingReasonLabel,
  pendingTypeLabel,
} from "../utils/pendingEditLabels";
import { pendingOverlayWidthPx } from "./pendingOverlayWidth";
import { type PendingDragEdge, pendingSpanAfterDrag } from "./pendingSpanDrag";

export interface PendingEditOverlayViewProps {
  edits: readonly PendingEditView[];
  trackId: string;
  zoomPxPerSec: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Commit a handle drag as new source seconds for the edit. */
  onCommitSpan: (
    editId: string,
    sourceStart: number,
    sourceEnd: number,
  ) => Promise<void> | void;
}

type DragState = {
  editId: string;
  spanIndex: number;
  edge: PendingDragEdge;
  originX: number;
  baseStart: number;
  baseEnd: number;
  sourceStart: number;
  sourceEnd: number;
};

function sourceFromTimelineDelta(
  sourceStart: number,
  sourceEnd: number,
  tlStart: number,
  tlEnd: number,
  newTlStart: number,
  newTlEnd: number,
): { start: number; end: number } {
  const tlDur = Math.max(1e-6, tlEnd - tlStart);
  const srcDur = sourceEnd - sourceStart;
  const ratio = srcDur / tlDur;
  return {
    start: sourceStart + (newTlStart - tlStart) * ratio,
    end: sourceStart + (newTlEnd - tlStart) * ratio,
  };
}

export function PendingEditOverlayView({
  edits,
  trackId,
  zoomPxPerSec,
  selectedId,
  onSelect,
  onCommitSpan,
}: PendingEditOverlayViewProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<{
    editId: string;
    spanIndex: number;
    start: number;
    end: number;
  } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const commitDrag = async (state: DragState, clientX: number) => {
    const dx = (clientX - state.originX) / zoomPxPerSec;
    const { start: tlStart, end: tlEnd } = pendingSpanAfterDrag(
      state.edge,
      state.baseStart,
      state.baseEnd,
      dx,
    );
    if (
      !isHandleDrag(state.originX, clientX) ||
      (tlStart === state.baseStart && tlEnd === state.baseEnd)
    ) {
      // A click (the sliver at session zoom is all handle), a drag back to
      // where it started, or one the 50 ms minimum clamps back to the same
      // bounds: pointerdown already selected the edit; never move or re-snap it.
      setDrag(null);
      setPreview(null);
      return;
    }
    const src = sourceFromTimelineDelta(
      state.sourceStart,
      state.sourceEnd,
      state.baseStart,
      state.baseEnd,
      tlStart,
      tlEnd,
    );
    try {
      await onCommitSpan(state.editId, src.start, src.end);
    } finally {
      setDrag(null);
      setPreview(null);
    }
  };

  return (
    <>
      {/* Defensive: TimelineView already passes this lane its own slice
          (laneOverlaySlices). The track filter stays so a wrong slice can
          never draw another track's edits; TimelineView.test pins slices. */}
      {edits
        .filter((e) => pendingEditTrackIds(e).includes(trackId) && e.mappable)
        .flatMap((edit) =>
          edit.timeline_spans.map((span, i) => {
            const isMute = edit.type === "mute";
            const isSplit = edit.type === "split";
            const isPreview =
              preview && preview.editId === edit.id && preview.spanIndex === i;
            const left =
              (isPreview ? preview!.start : span.start) * zoomPxPerSec;
            const right = (isPreview ? preview!.end : span.end) * zoomPxPerSec;
            const width = pendingOverlayWidthPx(edit.type, right - left);
            const handle = (edge: PendingDragEdge) => (
              <span
                className={`pending-handle ${edge}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  try {
                    (e.target as HTMLElement).setPointerCapture(e.pointerId);
                  } catch {
                    // optional — move/up still fire on the handle
                  }
                  setDrag({
                    editId: edit.id,
                    spanIndex: i,
                    edge,
                    originX: e.clientX,
                    baseStart: span.start,
                    baseEnd: span.end,
                    sourceStart: edit.source_start,
                    sourceEnd: edit.source_end,
                  });
                  setPreview({
                    editId: edit.id,
                    spanIndex: i,
                    start: span.start,
                    end: span.end,
                  });
                  onSelect(edit.id);
                }}
                onPointerMove={(e) => {
                  const d = dragRef.current;
                  if (!d || d.editId !== edit.id || d.spanIndex !== i) {
                    return;
                  }
                  const dx = (e.clientX - d.originX) / zoomPxPerSec;
                  setPreview({
                    editId: edit.id,
                    spanIndex: i,
                    ...pendingSpanAfterDrag(edge, d.baseStart, d.baseEnd, dx),
                  });
                }}
                onPointerUp={(e) => {
                  const d = dragRef.current;
                  if (!d) {
                    return;
                  }
                  void commitDrag(d, e.clientX);
                }}
              />
            );
            return (
              <div
                key={`${edit.id}-${i}`}
                className={`pending-overlay${isMute ? " mute" : isSplit ? " split" : " remove"}${selectedId === edit.id ? " selected" : ""}`}
                style={{ left, width }}
                title={`${pendingTypeLabel(edit.type)}: ${pendingReasonLabel(edit.reason)}`}
              >
                <button
                  type="button"
                  className="pending-hit"
                  aria-label={`Pending ${edit.type} edit`}
                  aria-pressed={selectedId === edit.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(edit.id);
                  }}
                />
                {isSplit ? null : (
                  <>
                    {handle("start")}
                    {handle("end")}
                  </>
                )}
              </div>
            );
          }),
        )}
    </>
  );
}
