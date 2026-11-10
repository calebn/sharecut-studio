import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { clamp } from "../utils/math";
import { snapToTick } from "./overviewSnap";

export type OverviewTick = {
  /** 0 to 1 across the episode. */
  at: number;
  kind: "suggestion" | "comment" | "find" | "chapter" | "session";
  current?: boolean;
};

const SNAP_PX = 10;

const KEY_STEP = 0.01;
const KEY_STEP_BIG = 0.1;

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
  /** Makes the strip a slider on the playhead: tap or drag seeks, a tick near the pointer wins. */
  onSeek?: (fraction: number) => void;
  /** Spoken value of the slider, such as a timecode. */
  valueText?: string;
};

/**
 * A whole-episode miniature. Static unless `onSeek` is given, which makes it
 * a slider on the playhead. Comments are dots, every other tick is a line.
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
  valueText,
}: OverviewStripProps) {
  const dragging = useRef(false);
  const fractionAt = (event: PointerEvent<HTMLDivElement>, snap: boolean) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return null;
    const raw = clamp((event.clientX - box.left) / box.width, 0, 1);
    return snap ? snapToTick(raw, ticks, SNAP_PX / box.width) : raw;
  };
  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (!onSeek || event.button !== 0) return;
    const fraction = fractionAt(event, true);
    if (fraction === null) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onSeek(fraction);
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (!onSeek || !dragging.current) return;
    const fraction = fractionAt(event, false);
    if (fraction !== null) onSeek(fraction);
  };
  const release = () => {
    dragging.current = false;
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSeek || event.ctrlKey || event.metaKey || event.altKey) return;
    const now = playhead ?? 0;
    const step = event.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    let target: number | null = null;
    if (event.key === "ArrowLeft") target = now - step;
    else if (event.key === "ArrowRight") target = now + step;
    else if (event.key === "PageDown") target = now - KEY_STEP_BIG;
    else if (event.key === "PageUp") target = now + KEY_STEP_BIG;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = 1;
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    onSeek(clamp(target, 0, 1));
  };
  const interactive = onSeek
    ? {
        role: "slider",
        tabIndex: 0,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": Math.round((playhead ?? 0) * 100),
        "aria-valuetext": valueText,
        onPointerDown: press,
        onPointerMove: drag,
        onPointerUp: release,
        onPointerCancel: release,
        onKeyDown: key,
      }
    : { role: "img" };
  const count = Math.max(peaks.length, 1);
  const lines = ticks.filter((tick) => tick.kind !== "comment");
  const dots = ticks.filter((tick) => tick.kind === "comment");
  return (
    <div
      className={`sys-overview sys-overview--${height}${onSeek ? " sys-overview--seek" : ""}`}
      aria-label={label}
      {...interactive}
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
