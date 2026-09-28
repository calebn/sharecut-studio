import { MIN_EDGE_SPAN_SEC } from "../edit/clipEdgePreview";

export type PendingDragEdge = "start" | "end";

/** Timeline span after dragging `edge` by `dxSec`; the other edge stays put. */
export function pendingSpanAfterDrag(
  edge: PendingDragEdge,
  baseStart: number,
  baseEnd: number,
  dxSec: number,
): { start: number; end: number } {
  return edge === "start"
    ? {
        start: Math.min(baseEnd - MIN_EDGE_SPAN_SEC, baseStart + dxSec),
        end: baseEnd,
      }
    : {
        start: baseStart,
        end: Math.max(baseStart + MIN_EDGE_SPAN_SEC, baseEnd + dxSec),
      };
}
