import { memo, useCallback, useRef } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDawStore } from "../state/dawStore";
import { formatRulerTime, niceTimeStep } from "../utils/time";
import {
  MIN_TIMELINE_WIDTH_PX,
  viewportChunkRange,
} from "../utils/timelineViewport";
import { Playhead } from "./Playhead";
import {
  estimateRulerLabelWidthPx,
  RULER_END_EDGE_PX,
  rulerEndTickDropped,
  rulerTickIndices,
} from "./rulerTicks";

/** A comment drag shorter than this (px) is an instant comment. */
const COMMENT_SPAN_MIN_PX = 4;

interface TimeRulerProps {
  /**
   * Visible canvas length in seconds (may exceed the session when zoomed out).
   * Drives width and tick marks.
   */
  durationSec: number;
  /**
   * Clip/session extent. Home/End and aria max use this so End still seeks
   * the last clip, not empty canvas padding.
   */
  sessionDurationSec: number;
  zoomPxPerSec: number;
  onSeek: (sec: number) => void;
  onFit?: () => void;
  commentMode?: boolean;
  onCommentAnchor?: (startSec: number, endSec: number | null) => void;
  hidePlayhead?: boolean;
}

/**
 * Tick labels for the 2048 px chunks on screen. The chunk range is selected
 * as a string, so scrolling re-renders the ticks only when a chunk comes or
 * goes, and a deep zoom never mounts millions of labels.
 */
const RulerTicks = memo(function RulerTicks({
  durationSec,
  zoomPxPerSec,
  width,
  step,
}: {
  durationSec: number;
  zoomPxPerSec: number;
  width: number;
  step: number;
}) {
  const range = useDawStore(
    useCallback(
      (s: { scrollLeft: number; timelineViewportWidth: number }) =>
        viewportChunkRange(s.scrollLeft, s.timelineViewportWidth, width).join(
          ":",
        ),
      [width],
    ),
  );
  const [c0 = 0, c1 = 0] = range.split(":").map(Number);
  const lastIndex = Math.floor(durationSec / step + 1e-9);
  const dropLast = rulerEndTickDropped(
    durationSec,
    step,
    zoomPxPerSec,
    width,
    estimateRulerLabelWidthPx(lastIndex * step, step),
  );
  return rulerTickIndices([c0, c1], step, zoomPxPerSec, durationSec).map(
    (i) => {
      if (dropLast && i === lastIndex) {
        return null;
      }
      const t = i * step;
      const leftPx = t * zoomPxPerSec;
      const endAligned =
        i === lastIndex && leftPx > width - RULER_END_EDGE_PX && t > 0;
      return (
        <span
          key={i}
          className={`ruler-tick${endAligned ? " ruler-tick--end" : ""}`}
          style={{ left: leftPx }}
        >
          {formatRulerTime(t, step)}
        </span>
      );
    },
  );
});

/**
 * The slider's value: the playhead, in quarter seconds while playing so the
 * ruler re-renders four times a second rather than every frame.
 */
function selectRulerValueSec(s: {
  isPlaying: boolean;
  playheadSec: number;
}): number {
  return s.isPlaying ? Math.floor(s.playheadSec * 4) / 4 : s.playheadSec;
}

export function TimeRuler({
  durationSec,
  sessionDurationSec,
  zoomPxPerSec,
  onSeek,
  onFit,
  commentMode = false,
  onCommentAnchor,
  hidePlayhead = false,
}: TimeRulerProps) {
  const valueSec = useDawStore(selectRulerValueSec);
  const width = Math.max(durationSec * zoomPxPerSec, MIN_TIMELINE_WIDTH_PX);
  const majorStep = niceTimeStep(zoomPxPerSec);
  const sessionEnd = Math.max(0, sessionDurationSec);

  const dragStart = useRef<number | null>(null);

  const secFromEvent = (el: HTMLElement, clientX: number) => {
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(durationSec, x / zoomPxPerSec));
  };

  return (
    <div
      className={`time-ruler${commentMode ? " comment-mode" : ""}`}
      style={{ width }}
      role="slider"
      tabIndex={0}
      {...presenceAnchorProps(presenceAnchor("ruler"))}
      aria-label={commentMode ? "Comment time anchor" : "Timeline position"}
      aria-valuemin={0}
      aria-valuemax={sessionEnd}
      aria-valuenow={valueSec}
      aria-valuetext={formatRulerTime(valueSec, majorStep, "floor")}
      onClick={(e) => {
        if (commentMode) {
          return;
        }
        onSeek(secFromEvent(e.currentTarget, e.clientX));
      }}
      onKeyDown={(e) => {
        const step = majorStep;
        const playheadSec = useDawStore.getState().playheadSec;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onSeek(Math.max(0, playheadSec - step));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onSeek(Math.min(durationSec, playheadSec + step));
        } else if (e.key === "Home") {
          e.preventDefault();
          onSeek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          onSeek(sessionEnd);
        }
      }}
      onDoubleClick={(e) => {
        if (commentMode) {
          return;
        }
        e.preventDefault();
        onFit?.();
      }}
      onPointerDown={(e) => {
        if (!commentMode || !onCommentAnchor) {
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        const sec = secFromEvent(e.currentTarget, e.clientX);
        dragStart.current = sec;
        onCommentAnchor(sec, null);
        onSeek(sec);
      }}
      onPointerMove={(e) => {
        if (!commentMode || !onCommentAnchor || dragStart.current == null) {
          return;
        }
        const sec = secFromEvent(e.currentTarget, e.clientX);
        const a = dragStart.current;
        const start = Math.min(a, sec);
        const end = Math.max(a, sec);
        if ((end - start) * zoomPxPerSec < COMMENT_SPAN_MIN_PX) {
          onCommentAnchor(start, null);
        } else {
          onCommentAnchor(start, end);
        }
      }}
      onPointerUp={(e) => {
        if (!commentMode || !onCommentAnchor || dragStart.current == null) {
          return;
        }
        const sec = secFromEvent(e.currentTarget, e.clientX);
        const a = dragStart.current;
        dragStart.current = null;
        const start = Math.min(a, sec);
        const end = Math.max(a, sec);
        if ((end - start) * zoomPxPerSec < COMMENT_SPAN_MIN_PX) {
          onCommentAnchor(start, null);
        } else {
          onCommentAnchor(start, end);
        }
      }}
      title={
        commentMode
          ? "Click for instant comment, drag for a span"
          : onFit
            ? "Double-click to fit session"
            : undefined
      }
    >
      <RulerTicks
        durationSec={durationSec}
        zoomPxPerSec={zoomPxPerSec}
        width={width}
        step={majorStep}
      />
      {!hidePlayhead ? <Playhead height="100%" /> : null}
    </div>
  );
}
