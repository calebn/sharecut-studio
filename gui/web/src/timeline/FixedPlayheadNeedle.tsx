import type { CSSProperties, ReactNode } from "react";
import { useDawStore } from "../state/dawStore";
import {
  fixedLineOffsetPx,
  fixedPlayheadLinePx,
} from "../utils/timelineViewport";

/**
 * The fixed playhead's line: at the playhead's true place in the view, so it
 * starts beside the headers at time 0 and holds at the center once playback
 * passes it.
 */
export function FixedPlayheadNeedle({
  headerOffsetPx,
  timeViewportPx,
  children,
}: {
  headerOffsetPx: number;
  timeViewportPx: number;
  children?: ReactNode;
}) {
  const playheadSec = useDawStore((s) => s.playheadSec);
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  const line = fixedPlayheadLinePx(
    headerOffsetPx,
    fixedLineOffsetPx(playheadSec, zoomPxPerSec, scrollLeft, timeViewportPx),
  );
  return (
    <div
      className="playhead playhead--fixed"
      style={{ "--timeline-fixed-line": `${line}px` } as CSSProperties}
      aria-hidden
    >
      {children}
    </div>
  );
}
