import { memo, useMemo } from "react";
import { dbToY, gainToDb } from "../system/envelopeMath";
import { clampLaneHeight } from "../system/laneMath";
import type { AutomationPoint, ClipRow } from "../types/project";
import { type ClipGainDip, clipGainDips } from "./clipGainOverlay";

type Props = {
  clips: readonly ClipRow[];
  /** The track's volume points as stored, by time. */
  points: readonly AutomationPoint[];
  /** Seconds at the left edge of the window; the same `start` the envelope takes. */
  start: number;
  pxPerSecond: number;
  /** In px: the window, not the canvas. */
  width: number;
  height: number;
};

/** Largest drop in dB a straight piece of a dip may span before it is cut into more pieces. */
const SEGMENT_DB = 3;
const MAX_STEPS = 24;

/**
 * A dip's pieces are linear in gain, which on the dB axis is a curve: each is
 * cut into equal gain steps so a fade to silence plunges as the line does
 * instead of running a straight chord.
 */
function dipPath(
  dip: ClipGainDip,
  start: number,
  pxPerSecond: number,
  height: number,
): string {
  const out: string[] = [];
  const spot = (time: number, gain: number) =>
    out.push(
      `${(time - start) * pxPerSecond},${dbToY(gainToDb(gain), height)}`,
    );
  dip.points.forEach((to, i) => {
    const from = dip.points[i - 1];
    if (!from) return spot(to.time, to.gain);
    const steps = Math.min(
      MAX_STEPS,
      Math.max(
        1,
        Math.ceil(
          Math.abs(gainToDb(to.gain) - gainToDb(from.gain)) / SEGMENT_DB,
        ),
      ),
    );
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      spot(
        from.time + (to.time - from.time) * t,
        from.gain + (to.gain - from.gain) * t,
      );
    }
  });
  return out.join(" ");
}

/**
 * Where a clip's fade or mute pulls the track's gain down (read-only, drawn
 * dashed under the envelope's own points). It shares the envelope's window and
 * its dB axis, so a dip sits on the line at the same gain.
 */
export const ClipGainDips = memo(function ClipGainDips({
  clips,
  points,
  start,
  pxPerSecond,
  width,
  height,
}: Props) {
  const lane = clampLaneHeight(height);
  const dips = useMemo(() => clipGainDips(clips, points), [clips, points]);
  const end = start + width / pxPerSecond;
  const shown = useMemo(
    () =>
      dips
        .filter((d) => {
          const from = d.points[0]!.time;
          const to = d.points[d.points.length - 1]!.time;
          return to >= start && from <= end;
        })
        .map((dip) => ({
          key: `${dip.clipId}:${dip.points[0]!.time}`,
          x: (dip.points[0]!.time - start) * pxPerSecond,
          path: dipPath(dip, start, pxPerSecond, lane),
        })),
    [dips, start, end, pxPerSecond, lane],
  );
  if (shown.length === 0) return null;
  return (
    <svg
      className="lane-envelope-dips"
      width={width}
      height={lane}
      aria-hidden="true"
    >
      {shown.map((dip, index) => (
        <g key={dip.key} data-testid="clip-gain-dip">
          <polyline
            fill="none"
            stroke="var(--color-envelope-line)"
            strokeWidth="1.5"
            strokeDasharray="3 2"
            opacity="0.7"
            points={dip.path}
          />
          {index === 0 && (
            <text
              x={Math.max(2, dip.x + 3)}
              y={12}
              fontSize={9}
              fill="var(--color-envelope-line)"
            >
              clip fade or mute
            </text>
          )}
        </g>
      ))}
    </svg>
  );
});
