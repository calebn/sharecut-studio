import { MIN_EDGE_SPAN_SEC } from "../edit/clipEdgePreview";

export type SocialDragMode = "move" | "start" | "end";

/** Social clip bounds after dragging `mode` by `dxSec` (`MIN_EDGE_SPAN_SEC` minimum span). */
export function socialSpanAfterDrag(
  mode: SocialDragMode,
  originStart: number,
  originEnd: number,
  dxSec: number,
): { start: number; end: number } {
  let start = originStart;
  let end = originEnd;
  if (mode === "move") {
    const dur = end - start;
    start = Math.max(0, start + dxSec);
    end = start + dur;
  } else if (mode === "start") {
    start = Math.min(end - MIN_EDGE_SPAN_SEC, Math.max(0, start + dxSec));
  } else {
    end = Math.max(start + MIN_EDGE_SPAN_SEC, end + dxSec);
  }
  return { start, end };
}
