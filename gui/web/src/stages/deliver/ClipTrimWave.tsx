import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useRef,
} from "react";
import { capturePointer, pointerRatio } from "../../system/wavePointer";
import { PeakStrip } from "../../system/waveStrip";
import { clamp } from "../../utils/math";
import {
  type ClipWord,
  snapToWord,
  type TimeWindow,
  type TrimEdge,
} from "./clipTrim";
import { formatClock } from "./deliverLogic";

type Props = {
  name: string;
  /** Peaks across the window, 0 to 1. */
  peaks?: readonly number[];
  window: TimeWindow;
  start: number;
  end: number;
  /** Episode words; without them the handles move freely. */
  words?: readonly ClipWord[];
  onTrim: (edge: TrimEdge, at: number) => void;
  /** True while a drag or arrow presses are moving a handle, false once they settle. */
  onGesture?: (active: boolean) => void;
};

const EDGE_NAME: Record<TrimEdge, string> = { start: "In", end: "Out" };
const NO_PEAKS = [0];
const NO_WORDS: readonly ClipWord[] = [];

/** The clip as a strip of peaks with In and Out handles. Dragging snaps to words; hold Alt to move freely. The arrows move 10 ms, Shift 100 ms. */
export function ClipTrimWave({
  name,
  peaks = NO_PEAKS,
  window,
  start,
  end,
  words = NO_WORDS,
  onTrim,
  onGesture,
}: Props) {
  const release = useEffectEvent(() => onGesture?.(false));
  useEffect(() => () => release(), []);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<TrimEdge | null>(null);
  const span = Math.max(window.end - window.start, 0.001);
  const ratio = (time: number) => clamp((time - window.start) / span, 0, 1);
  const percent = (value: number) => `${Number((value * 100).toFixed(3))}%`;
  const inside = (time: number) => clamp(time, window.start, window.end);

  const onDown = (edge: TrimEdge) => (event: PointerEvent<HTMLElement>) => {
    dragging.current = edge;
    capturePointer(event);
  };
  const onMove = (event: PointerEvent<HTMLElement>) => {
    const edge = dragging.current;
    if (!edge || event.buttons === 0) return;
    const raw =
      window.start + pointerRatio(track.current, event.clientX) * span;
    onGesture?.(true);
    onTrim(edge, inside(event.altKey ? raw : snapToWord(words, edge, raw)));
  };
  const onUp = () => {
    dragging.current = null;
    onGesture?.(false);
  };
  const onKey = (edge: TrimEdge) => (event: KeyboardEvent<HTMLElement>) => {
    const direction =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const current = edge === "start" ? start : end;
    const next = current + direction * (event.shiftKey ? 0.1 : 0.01);
    onGesture?.(true);
    onTrim(edge, inside(next));
  };

  const handle = (edge: TrimEdge) => {
    const value = edge === "start" ? start : end;
    return (
      <span
        className="sys-wave-handle"
        data-edge={edge}
        role="slider"
        tabIndex={0}
        aria-label={`${EDGE_NAME[edge]} handle of ${name}`}
        aria-orientation="horizontal"
        aria-valuemin={Number(window.start.toFixed(2))}
        aria-valuemax={Number(window.end.toFixed(2))}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={formatClock(value)}
        style={{ insetInlineStart: percent(ratio(value)) }}
        onPointerDown={onDown(edge)}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={onUp}
        onKeyDown={onKey(edge)}
        onBlur={() => onGesture?.(false)}
      >
        <span className="sys-wave-knob dv-trim-knob" />
      </span>
    );
  };

  return (
    <div
      ref={track}
      className="sys-wave dv-trim-wave"
      role="group"
      aria-label={`Waveform of ${name}`}
    >
      <PeakStrip peaks={peaks.length === 0 ? NO_PEAKS : peaks} />
      <span
        className="dv-trim-region"
        style={{
          insetInlineStart: percent(ratio(start)),
          inlineSize: percent(ratio(end) - ratio(start)),
        }}
      />
      {handle("start")}
      {handle("end")}
    </div>
  );
}
