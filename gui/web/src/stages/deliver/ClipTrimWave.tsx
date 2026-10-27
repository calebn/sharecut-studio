import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useRef,
} from "react";
import {
  type ClipWord,
  fineStep,
  snapToWord,
  stepWords,
  type TimeWindow,
  type TrimEdge,
} from "./clipTrim";
import { formatClock } from "./deliverLogic";

type Props = {
  /** The clip's name, for the handles' labels. */
  name: string;
  /** Peaks across the window, 0 to 1. */
  peaks: readonly number[];
  window: TimeWindow;
  start: number;
  end: number;
  /** Episode words; without them the handles move freely. */
  words?: readonly ClipWord[];
  onTrim: (edge: TrimEdge, at: number) => void;
};

const EDGE_NAME: Record<TrimEdge, string> = { start: "In", end: "Out" };

/** The clip as a strip of peaks with In and Out handles. Dragging snaps to words; hold Alt to move freely. */
export function ClipTrimWave({
  name,
  peaks,
  window,
  start,
  end,
  words = [],
  onTrim,
}: Props) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<TrimEdge | null>(null);
  const span = Math.max(window.end - window.start, 0.001);
  const percent = (time: number) =>
    `${Number((((time - window.start) / span) * 100).toFixed(3))}%`;
  const inside = (time: number) =>
    Math.min(window.end, Math.max(window.start, time));

  const timeAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - (rect?.left ?? 0)) / (rect?.width || 1)),
    );
    return window.start + ratio * span;
  };

  const onDown = (edge: TrimEdge) => (event: PointerEvent<HTMLElement>) => {
    dragging.current = edge;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
  };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const edge = dragging.current;
    if (!edge) return;
    const raw = timeAt(event.clientX);
    onTrim(edge, inside(event.altKey ? raw : snapToWord(words, edge, raw)));
  };
  const onUp = () => {
    dragging.current = null;
  };
  const onKey = (edge: TrimEdge) => (event: KeyboardEvent<HTMLElement>) => {
    const direction =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const current = edge === "start" ? start : end;
    const free = event.altKey || words.length === 0;
    const next = free
      ? current + direction * fineStep(event.shiftKey)
      : stepWords(words, edge, current, direction * (event.shiftKey ? 10 : 1));
    onTrim(edge, inside(next));
  };

  const handle = (edge: TrimEdge) => {
    const value = edge === "start" ? start : end;
    return (
      <span
        className="dv-trim-handle"
        data-edge={edge}
        role="slider"
        tabIndex={0}
        aria-label={`${EDGE_NAME[edge]} handle of ${name}`}
        aria-orientation="horizontal"
        aria-valuemin={Number(window.start.toFixed(2))}
        aria-valuemax={Number(window.end.toFixed(2))}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={formatClock(value)}
        style={{ insetInlineStart: percent(value) } as CSSProperties}
        onPointerDown={onDown(edge)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey(edge)}
      >
        <span className="dv-trim-knob" />
      </span>
    );
  };

  const count = Math.max(peaks.length, 1);
  return (
    <div
      ref={track}
      className="dv-trim-wave"
      role="group"
      aria-label={`Waveform of ${name}`}
    >
      <svg
        viewBox={`0 0 ${count} 1`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {peaks.length === 0 ? (
          <rect
            className="dv-trim-peak"
            x={0}
            y={0.48}
            width={1}
            height={0.04}
          />
        ) : (
          peaks.map((peak, index) => {
            const x = index + 0.15;
            return (
              <rect
                key={x}
                className="dv-trim-peak"
                x={x}
                y={(1 - peak) / 2}
                width={0.7}
                height={Math.max(peak, 0.04)}
              />
            );
          })
        )}
      </svg>
      <span
        className="dv-trim-region"
        style={
          {
            insetInlineStart: percent(start),
            inlineSize: `${Number((((end - start) / span) * 100).toFixed(3))}%`,
          } as CSSProperties
        }
      />
      {handle("start")}
      {handle("end")}
    </div>
  );
}
