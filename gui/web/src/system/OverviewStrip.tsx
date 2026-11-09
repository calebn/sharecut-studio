import { type KeyboardEvent, type MouseEvent, useRef } from "react";
import { clamp } from "../utils/math";
import { formatTime } from "../utils/time";
import { swallowsDuringDrag, useGrab } from "./useGrab";
import { pointerRatio } from "./wavePointer";

export type OverviewTick = {
  /** 0 to 1 across the episode. */
  at: number;
  kind: "suggestion" | "comment" | "find" | "chapter" | "session";
  current?: boolean;
};

export type OverviewStripProps = {
  /** 16 phone Edit, 32 Review, 48 Project card (static), 64 expanded Player. */
  height: 16 | 32 | 48 | 64;
  /** Peak heights, 0 to 1. A flat line when empty. */
  peaks?: readonly number[];
  playhead?: number;
  viewport?: readonly [number, number];
  selection?: readonly [number, number];
  ticks?: readonly OverviewTick[];
  label: string;
  /** Seeks to a 0 to 1 fraction of the episode. Without it the strip is a picture. */
  onSeek?: (fraction: number) => void;
  /** Episode length in seconds; sizes the arrow-key steps and the slider value. */
  duration?: number;
};

const KEY_STEP_SEC = 1;
const KEY_STEP_BIG_SEC = 10;

/**
 * A whole-episode miniature. With `onSeek` it is a slider: a click or a drag
 * seeks, Escape puts a drag back, the arrows step by seconds.
 * Comments are dots, every other tick is a line.
 */
export function OverviewStrip({
  height,
  peaks = [],
  playhead,
  viewport,
  selection,
  ticks = [],
  label,
  onSeek,
  duration = 0,
}: OverviewStripProps) {
  const root = useRef<HTMLDivElement>(null);
  const dragFrom = useRef(0);
  const grab = useGrab<"scrub">({
    canGrab: () => onSeek !== undefined,
    captureOnStart: () => root.current,
    onStart: () => {
      dragFrom.current = playhead ?? 0;
      return true;
    },
    onMove: (_, move) => onSeek?.(pointerRatio(root.current, move.clientX)),
    onEnd: (_, committed) => {
      if (!committed) onSeek?.(dragFrom.current);
    },
  });
  const count = Math.max(peaks.length, 1);
  const lines = ticks.filter((tick) => tick.kind !== "comment");
  const dots = ticks.filter((tick) => tick.kind === "comment");
  const click = (event: MouseEvent<HTMLElement>) => {
    if (grab.consumeClick(event)) return;
    onSeek?.(pointerRatio(root.current, event.clientX));
  };
  const key = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSeek || duration <= 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (grab.dragging() && swallowsDuringDrag(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const from = playhead ?? 0;
    const step = (event.shiftKey ? KEY_STEP_BIG_SEC : KEY_STEP_SEC) / duration;
    const target =
      event.key === "ArrowLeft"
        ? from - step
        : event.key === "ArrowRight"
          ? from + step
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? 1
              : null;
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    onSeek(clamp(target, 0, 1));
  };
  const seconds = clamp(playhead ?? 0, 0, 1) * duration;
  const seekProps = onSeek
    ? {
        role: "slider",
        tabIndex: 0,
        "aria-orientation": "horizontal" as const,
        "aria-valuemin": 0,
        "aria-valuemax": duration,
        "aria-valuenow": seconds,
        "aria-valuetext": formatTime(seconds),
        onClick: click,
        onKeyDown: key,
        ...grab.handlers("scrub"),
      }
    : { role: "img" };
  return (
    <div
      ref={root}
      className={`sys-overview sys-overview--${height}${onSeek ? " sys-overview--seek" : ""}`}
      aria-label={label}
      {...seekProps}
    >
      <svg
        viewBox={`0 0 ${count} 1`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {selection ? (
          <rect
            className="sys-overview-selection"
            x={selection[0] * count}
            y={0}
            width={(selection[1] - selection[0]) * count}
            height={1}
          />
        ) : null}
        {peaks.length === 0 ? (
          <rect
            className="sys-overview-peak"
            x={0}
            y={0.48}
            width={1}
            height={0.04}
          />
        ) : (
          peaks.map((peak, index) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed order
              key={index}
              className="sys-overview-peak"
              x={index + 0.15}
              y={(1 - peak) / 2}
              width={0.7}
              height={Math.max(peak, 0.04)}
            />
          ))
        )}
        {lines.map((tick) => (
          <line
            key={`${tick.kind}-${tick.at}-${tick.current ? "now" : ""}`}
            className={`sys-overview-tick sys-overview-tick--${tick.kind}${tick.current ? " is-current" : ""}`}
            x1={tick.at * count}
            x2={tick.at * count}
            y1={0}
            y2={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {dots.map((tick) => (
        <span
          key={`${tick.kind}-${tick.at}-${tick.current ? "now" : ""}`}
          className={`sys-overview-dot${tick.current ? " is-current" : ""}`}
          style={{ insetInlineStart: `${tick.at * 100}%` }}
        />
      ))}
      {viewport ? (
        <span
          className="sys-overview-viewport"
          style={{
            insetInlineStart: `${viewport[0] * 100}%`,
            inlineSize: `${(viewport[1] - viewport[0]) * 100}%`,
          }}
        />
      ) : null}
      {playhead === undefined ? null : (
        <span
          className="sys-overview-playhead"
          style={{ insetInlineStart: `${playhead * 100}%` }}
        />
      )}
    </div>
  );
}
