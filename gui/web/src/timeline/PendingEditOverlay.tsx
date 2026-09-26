import { useRef, useState } from "react";
import { updatePendingEdit } from "../api";
import { isHandleDrag } from "../edit/dragThreshold";
import { useDaw } from "../state/useDaw";
import type { PendingEditView } from "../types/project";
import {
  pendingReasonLabel,
  pendingTypeLabel,
} from "../utils/pendingEditLabels";
import { pendingOverlayWidthPx } from "./pendingOverlayWidth";

interface PendingEditOverlayProps {
  edits: PendingEditView[];
  trackId: string;
  zoomPxPerSec: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

type DragEdge = "start" | "end";

type DragState = {
  editId: string;
  spanIndex: number;
  edge: DragEdge;
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

export function PendingEditOverlay({
  edits,
  trackId,
  zoomPxPerSec,
  selectedId,
  onSelect,
}: PendingEditOverlayProps) {
  const { projectPath } = useDaw((s) => ({ projectPath: s.projectPath }));
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
    if (!isHandleDrag(state.originX, clientX)) {
      // A click (the sliver at session zoom is all handle): pointerdown
      // already selected the edit; never move or re-snap it.
      setDrag(null);
      setPreview(null);
      return;
    }
    const dx = (clientX - state.originX) / zoomPxPerSec;
    let tlStart = state.baseStart;
    let tlEnd = state.baseEnd;
    if (state.edge === "start") {
      tlStart = Math.min(state.baseEnd - 0.05, state.baseStart + dx);
    } else {
      tlEnd = Math.max(state.baseStart + 0.05, state.baseEnd + dx);
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
      await updatePendingEdit(
        projectPath,
        state.editId,
        src.start,
        src.end,
        true,
      );
    } finally {
      setDrag(null);
      setPreview(null);
    }
  };

  return (
    <>
      {edits
        .filter((e) => {
          const tids = e.track_ids?.length ? e.track_ids : [e.track_id];
          return tids.includes(trackId) && e.mappable;
        })
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
                    <span
                      className="pending-handle start"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        (e.target as HTMLElement).setPointerCapture(
                          e.pointerId,
                        );
                        const next: DragState = {
                          editId: edit.id,
                          spanIndex: i,
                          edge: "start",
                          originX: e.clientX,
                          baseStart: span.start,
                          baseEnd: span.end,
                          sourceStart: edit.source_start,
                          sourceEnd: edit.source_end,
                        };
                        setDrag(next);
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
                        const start = Math.min(
                          d.baseEnd - 0.05,
                          d.baseStart + dx,
                        );
                        setPreview({
                          editId: edit.id,
                          spanIndex: i,
                          start,
                          end: d.baseEnd,
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
                    <span
                      className="pending-handle end"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        (e.target as HTMLElement).setPointerCapture(
                          e.pointerId,
                        );
                        const next: DragState = {
                          editId: edit.id,
                          spanIndex: i,
                          edge: "end",
                          originX: e.clientX,
                          baseStart: span.start,
                          baseEnd: span.end,
                          sourceStart: edit.source_start,
                          sourceEnd: edit.source_end,
                        };
                        setDrag(next);
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
                        const end = Math.max(
                          d.baseStart + 0.05,
                          d.baseEnd + dx,
                        );
                        setPreview({
                          editId: edit.id,
                          spanIndex: i,
                          start: d.baseStart,
                          end,
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
                  </>
                )}
              </div>
            );
          }),
        )}
    </>
  );
}
