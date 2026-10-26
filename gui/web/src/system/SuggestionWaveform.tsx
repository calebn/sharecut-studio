import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useRef,
} from "react";
import { KIND_META, type ReviewKind } from "../review/reviewKinds";
import { SystemIcon } from "./SystemIcon";
import {
  clampRange,
  type SuggestionRange,
  snapToSilence,
  WAVEFORM_WINDOW_S,
} from "./silenceSnap";

const KEY_STEP_S = 0.05;
const KEY_STEP_BIG_S = 0.5;

export type SuggestionWaveformProps = {
  kind: Exclude<ReviewKind, "comment" | "check" | "unsure-word">;
  /** Peaks across the window, 0 to 1. */
  peaks: readonly number[];
  /** Episode time at the left edge. The window is 12 s: 6 s each side of the change. */
  windowStart: number;
  start: number;
  end: number;
  /** A guest sees the change and cannot move it. */
  readOnly?: boolean;
  /** The first movement of a drag or key press. */
  onAdjustStart?: () => void;
  onAdjust?: (range: SuggestionRange) => void;
  label?: string;
};

type Edge = "start" | "end";

/**
 * The 96 px waveform of one suggestion, 6 s either side. The proposed range is
 * hatched with a 2 px outline and a kind glyph. Each edge has a 12 px handle
 * with a 44 px hit area. Dragging snaps to silence; hold Alt to move freely.
 */
export function SuggestionWaveform({
  kind,
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
  const bounds: SuggestionRange = {
    start: windowStart,
    end: windowStart + WAVEFORM_WINDOW_S,
  };
  const percent = (time: number) =>
    `${((time - windowStart) / WAVEFORM_WINDOW_S) * 100}%`;

  const move = (edge: Edge, time: number, free: boolean) => {
    const snapped = free
      ? time
      : windowStart +
        snapToSilence(time - windowStart, peaks, {
          windowSeconds: WAVEFORM_WINDOW_S,
        });
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
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    onAdjustStart?.();
  };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const edge = dragging.current;
    if (edge) move(edge, timeAt(event.clientX), event.altKey);
  };
  const onUp = () => {
    dragging.current = null;
  };
  const onKey = (edge: Edge) => (event: KeyboardEvent<HTMLElement>) => {
    const direction =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (readOnly || direction === 0) return;
    event.preventDefault();
    onAdjustStart?.();
    const step = event.shiftKey ? KEY_STEP_BIG_S : KEY_STEP_S;
    move(edge, (edge === "start" ? start : end) + direction * step, true);
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
    <div
      ref={track}
      className="sys-wave"
      data-kind={kind}
      role="group"
      aria-label={label}
    >
      <svg
        viewBox={`0 0 ${count} 1`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {peaks.map((peak, index) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed order
            key={index}
            className="sys-wave-peak"
            x={index + 0.15}
            y={(1 - peak) / 2}
            width={0.7}
            height={Math.max(peak, 0.04)}
          />
        ))}
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
        <SystemIcon name={KIND_META[kind].icon} size={16} />
      </span>
      {handle("start")}
      {handle("end")}
    </div>
  );
}
