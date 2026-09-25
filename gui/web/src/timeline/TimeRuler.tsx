import { memo, useMemo, useRef } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { useDawStore } from "../state/dawStore";
import { formatTimeShort, rulerTickTimes } from "../utils/time";
import { MIN_TIMELINE_WIDTH_PX } from "../utils/timelineViewport";
import { Playhead } from "./Playhead";
import {
  dropCollidingRulerEndTick,
  estimateRulerLabelWidthPx,
  RULER_END_EDGE_PX,
} from "./rulerTicks";

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

/** Tick labels; re-render only for a new canvas length or zoom. */
const RulerTicks = memo(function RulerTicks({
  ticks,
  zoomPxPerSec,
  width,
}: {
  ticks: number[];
  zoomPxPerSec: number;
  width: number;
}) {
  return ticks.map((t, i) => {
    const leftPx = t * zoomPxPerSec;
    const endAligned =
      i === ticks.length - 1 && leftPx > width - RULER_END_EDGE_PX && t > 0;
    return (
      <span
        key={t}
        className={`ruler-tick${endAligned ? " ruler-tick--end" : ""}`}
        style={{ left: leftPx }}
      >
        {formatTimeShort(t)}
      </span>
    );
  });
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
  const ticks = useMemo(() => {
    const rawTicks = rulerTickTimes(durationSec, zoomPxPerSec);
    return dropCollidingRulerEndTick(
      rawTicks,
      zoomPxPerSec,
      width,
      estimateRulerLabelWidthPx(rawTicks),
    );
  }, [durationSec, zoomPxPerSec, width]);
  const majorStep =
    ticks.length >= 2 ? ticks[1]! - ticks[0]! : Math.max(1, durationSec);
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
      aria-valuetext={formatTimeShort(valueSec)}
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
        if (end - start < 0.05) {
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
        if (end - start < 0.05) {
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
      <RulerTicks ticks={ticks} zoomPxPerSec={zoomPxPerSec} width={width} />
      {!hidePlayhead ? <Playhead height="100%" /> : null}
    </div>
  );
}
