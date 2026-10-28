import { memo, type ReactNode } from "react";
import { presenceAnchor, presenceAnchorProps } from "../presence/anchors";
import { clampToSession, formatRulerTime, niceTimeStep } from "../utils/time";
import { MIN_TIMELINE_WIDTH_PX } from "../utils/timelineViewport";
import {
  estimateRulerLabelWidthPx,
  RULER_END_EDGE_PX,
  rulerEndTickDropped,
  rulerTickIndices,
} from "./rulerTicks";
import { timelineTestIds } from "./selectors";

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
  valueSec,
  getPlayheadSec,
  visibleChunks,
  playhead,
}: TimeRulerViewProps) {
  const width = Math.max(durationSec * zoomPxPerSec, MIN_TIMELINE_WIDTH_PX);
  const majorStep = niceTimeStep(zoomPxPerSec);
  const sessionEnd = Math.max(0, sessionDurationSec);

  const secFromEvent = (el: HTMLElement, clientX: number) => {
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    return clampToSession(x / zoomPxPerSec, durationSec);
  };

  return (
    <div
      data-testid={timelineTestIds.ruler}
      className="time-ruler"
      style={{ width }}
      role="slider"
      tabIndex={0}
      {...presenceAnchorProps(presenceAnchor("ruler"))}
      aria-label="Timeline position"
      aria-valuemin={0}
      aria-valuemax={sessionEnd}
      aria-valuenow={valueSec}
      aria-valuetext={formatRulerTime(valueSec, majorStep)}
      onClick={(e) => {
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
        e.preventDefault();
        onFit?.();
      }}
      title={onFit ? "Double-click to fit session" : undefined}
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
