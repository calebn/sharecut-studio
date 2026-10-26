import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useRef,
} from "react";
import type { SystemIconName } from "./icons";
import { SystemIcon } from "./SystemIcon";
import type { TimeRange } from "./seconds";
import { clampRange, snapToSilence, WAVEFORM_WINDOW_S } from "./silenceSnap";

const KEY_STEP_S = 0.05;
const KEY_STEP_BIG_S = 0.5;
const KEY_STEP_PAGE_S = 1;

export type SuggestionWaveformProps = {
  /** The change's kind glyph. */
  icon: SystemIconName;
  /** Peaks across the window, 0 to 1. */
  peaks: readonly number[];
  /** Episode seconds at the left edge. */
  windowStart: number;
  start: number;
  end: number;
  /** A guest sees the change and cannot move it. */
  readOnly?: boolean;
  /** Fires on the first movement of a drag and on each key press, never on a tap. */
  onAdjustStart?: () => void;
  onAdjust?: (range: TimeRange) => void;
  label?: string;
};

type Edge = "start" | "end";

/** Dragging snaps to silence; hold Alt to move freely. Handles keep a 44 px hit area around the 12 px knob. */
export function SuggestionWaveform({
  icon,
  peaks,
  windowStart,
  start,
  end,
  readOnly = false,
  onAdjustStart,
  onAdjust,
  label = "Waveform around the change",
}: SuggestionWaveformProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<Edge | null>(null);
  const started = useRef(false);
  const bounds: TimeRange = {
    start: windowStart,
    end: windowStart + WAVEFORM_WINDOW_S,
  };
  const percent = (time: number) =>
    `${((time - windowStart) / WAVEFORM_WINDOW_S) * 100}%`;

  const move = (edge: Edge, time: number, free: boolean) => {
    const snapped = free
      ? time
      : windowStart +
        snapToSilence(time - windowStart, peaks, WAVEFORM_WINDOW_S);
    onAdjust?.(clampRange({ start, end, [edge]: snapped }, edge, bounds));
  };

  const timeAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    const width = rect?.width || 1;
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - (rect?.left ?? 0)) / width),
    );
    return windowStart + ratio * WAVEFORM_WINDOW_S;
  };

  const onDown = (edge: Edge) => (event: PointerEvent<HTMLElement>) => {
    if (readOnly) return;
    dragging.current = edge;
    started.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
  };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const edge = dragging.current;
    if (!edge) return;
    if (!started.current) {
      started.current = true;
      onAdjustStart?.();
    }
    move(edge, timeAt(event.clientX), event.altKey);
  };
  const onUp = () => {
    dragging.current = null;
  };
  const onKey = (edge: Edge) => (event: KeyboardEvent<HTMLElement>) => {
    const current = edge === "start" ? start : end;
    const target =
      event.key === "ArrowLeft"
        ? current - (event.shiftKey ? KEY_STEP_BIG_S : KEY_STEP_S)
        : event.key === "ArrowRight"
          ? current + (event.shiftKey ? KEY_STEP_BIG_S : KEY_STEP_S)
          : event.key === "PageDown"
            ? current - KEY_STEP_PAGE_S
            : event.key === "PageUp"
              ? current + KEY_STEP_PAGE_S
              : event.key === "Home"
                ? bounds.start
                : event.key === "End"
                  ? bounds.end
                  : null;
    if (readOnly || target === null) return;
    event.preventDefault();
    onAdjustStart?.();
    move(edge, target, true);
  };

  const handle = (edge: Edge) => {
    const value = edge === "start" ? start : end;
    return (
      <span
        className="sys-wave-handle"
        data-edge={edge}
        role="slider"
        tabIndex={readOnly ? -1 : 0}
        aria-label={
          edge === "start" ? "Start of the change" : "End of the change"
        }
        aria-orientation="horizontal"
        aria-readonly={readOnly || undefined}
        aria-valuemin={Number(bounds.start.toFixed(2))}
        aria-valuemax={Number(bounds.end.toFixed(2))}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={`${value.toFixed(2)} s`}
        style={{ insetInlineStart: percent(value) } as CSSProperties}
        onPointerDown={onDown(edge)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey(edge)}
      >
        <span className="sys-wave-knob" />
      </span>
    );
  };

  const count = Math.max(peaks.length, 1);
  return (
    <div ref={track} className="sys-wave" role="group" aria-label={label}>
      <svg
        viewBox={`0 0 ${count} 1`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {peaks.map((peak, index) => {
          const x = index + 0.15;
          return (
            <rect
              key={x}
              className="sys-wave-peak"
              x={x}
              y={(1 - peak) / 2}
              width={0.7}
              height={Math.max(peak, 0.04)}
            />
          );
        })}
      </svg>
      <span
        className="sys-wave-region"
        style={
          {
            insetInlineStart: percent(start),
            inlineSize: `${((end - start) / WAVEFORM_WINDOW_S) * 100}%`,
          } as CSSProperties
        }
      >
        <SystemIcon name={icon} size={16} />
      </span>
      {handle("start")}
      {handle("end")}
    </div>
  );
}
