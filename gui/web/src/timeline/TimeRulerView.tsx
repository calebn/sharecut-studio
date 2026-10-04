import { memo, type ReactNode, useCallback, useEffect, useRef } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { clampToSession, formatRulerTime, niceTimeStep } from "../utils/time";
import { MIN_TIMELINE_WIDTH_PX } from "../utils/timelineViewport";
import type {
  CommentAnchorGesture,
  CommentAnchorSession,
} from "./commentAnchorSession";
import {
  estimateRulerLabelWidthPx,
  RULER_END_EDGE_PX,
  rulerEndTickDropped,
  rulerTickIndices,
} from "./rulerTicks";
import { timelineTestIds } from "./selectors";

/** A comment drag shorter than this (px) is an instant comment. */
const COMMENT_SPAN_MIN_PX = 4;

export interface TimeRulerViewProps {
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
  commentGesture?: CommentAnchorGesture;
  /** Display value may be throttled while audio is playing. */
  valueSec: number;
  /** Reads the precise current position when a keyboard step is requested. */
  getPlayheadSec: () => number;
  visibleChunks: readonly [number, number];
  playhead?: ReactNode;
}

/**
 * Tick labels for the 2048 px chunks on screen. The live adapter selects the
 * range only when a chunk changes, so a deep zoom never mounts millions of
 * labels.
 */
const RulerTicks = memo(function RulerTicks({
  durationSec,
  zoomPxPerSec,
  width,
  step,
  visibleChunks,
}: {
  durationSec: number;
  zoomPxPerSec: number;
  width: number;
  step: number;
  visibleChunks: readonly [number, number];
}) {
  const [c0, c1] = visibleChunks;
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
          data-testid={
            endAligned
              ? timelineTestIds.rulerEndTick
              : timelineTestIds.rulerTick
          }
          className={`ruler-tick${endAligned ? " ruler-tick--end" : ""}`}
          style={{ left: leftPx }}
        >
          {formatRulerTime(t, step)}
        </span>
      );
    },
  );
});

/** Prop-driven ruler used by the live adapter and the component catalog. */
export function TimeRulerView({
  durationSec,
  sessionDurationSec,
  zoomPxPerSec,
  onSeek,
  onFit,
  commentMode = false,
  commentGesture,
  valueSec,
  getPlayheadSec,
  visibleChunks,
  playhead,
}: TimeRulerViewProps) {
  const width = Math.max(durationSec * zoomPxPerSec, MIN_TIMELINE_WIDTH_PX);
  const majorStep = niceTimeStep(zoomPxPerSec);
  const sessionEnd = Math.max(0, sessionDurationSec);

  const drag = useRef<{
    pointerId: number;
    target: HTMLElement;
    startSec: number;
    session: CommentAnchorSession;
  } | null>(null);
  const cancelDrag = useCallback(() => {
    const owner = drag.current;
    if (!owner) return;
    drag.current = null;
    owner.session.cancel();
    try {
      if (owner.target.hasPointerCapture(owner.pointerId))
        owner.target.releasePointerCapture(owner.pointerId);
    } catch {}
  }, []);
  useEffect(() => cancelDrag, [cancelDrag, commentGesture]);
  useEffect(() => {
    if (!commentMode) cancelDrag();
  }, [commentMode, cancelDrag]);

  const secFromEvent = (el: HTMLElement, clientX: number) => {
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    return clampToSession(x / zoomPxPerSec, durationSec);
  };

  return (
    <div
      data-testid={timelineTestIds.ruler}
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
        const playheadSec = getPlayheadSec();
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          e.stopPropagation();
          onSeek(Math.max(0, playheadSec - step));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          onSeek(Math.min(durationSec, playheadSec + step));
        } else if (e.key === "Home") {
          e.preventDefault();
          e.stopPropagation();
          onSeek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          e.stopPropagation();
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
        if (
          !commentMode ||
          !commentGesture ||
          drag.current ||
          e.button !== 0 ||
          !e.isPrimary
        )
          return;
        const target = e.currentTarget;
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          return;
        }
        const session = commentGesture.begin(cancelDrag);
        if (!session) {
          target.releasePointerCapture(e.pointerId);
          return;
        }
        const sec = secFromEvent(target, e.clientX);
        drag.current = {
          pointerId: e.pointerId,
          target,
          startSec: sec,
          session,
        };
        session.preview({ startSec: sec, endSec: null });
        if (drag.current) onSeek(sec);
      }}
      onPointerMove={(e) => {
        const owner = drag.current;
        if (!owner || owner.pointerId !== e.pointerId) return;
        const sec = secFromEvent(owner.target, e.clientX);
        const startSec = Math.min(owner.startSec, sec);
        const endSec = Math.max(owner.startSec, sec);
        owner.session.preview({
          startSec,
          endSec:
            (endSec - startSec) * zoomPxPerSec < COMMENT_SPAN_MIN_PX
              ? null
              : endSec,
        });
      }}
      onPointerUp={(e) => {
        const owner = drag.current;
        if (!owner || owner.pointerId !== e.pointerId) return;
        const sec = secFromEvent(owner.target, e.clientX);
        const startSec = Math.min(owner.startSec, sec);
        const endSec = Math.max(owner.startSec, sec);
        drag.current = null;
        owner.session.finish({
          startSec,
          endSec:
            (endSec - startSec) * zoomPxPerSec < COMMENT_SPAN_MIN_PX
              ? null
              : endSec,
        });
        try {
          if (owner.target.hasPointerCapture(owner.pointerId))
            owner.target.releasePointerCapture(owner.pointerId);
        } catch {}
      }}
      onPointerCancel={(e) => {
        if (drag.current?.pointerId === e.pointerId) cancelDrag();
      }}
      onLostPointerCapture={(e) => {
        if (drag.current?.pointerId === e.pointerId) cancelDrag();
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
        visibleChunks={visibleChunks}
      />
      {playhead}
    </div>
  );
}
