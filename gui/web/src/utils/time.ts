export function formatTime(
  sec: number,
  opts?: { forceHours?: boolean },
): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const whole = Math.floor(s);
  const ms = Math.floor((s - whole) * 1000);
  if (opts?.forceHours || h > 0) {
    // Pad hours so playhead/duration share a fixed layout in the transport.
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Episodes an hour or longer lay every transport time out as hh:mm:ss. */
function hoursLayout(durationSec: number): boolean {
  return durationSec >= 3600;
}

/** Stable transport label: same digit layout for playhead and duration. */
export function formatTimecodePair(
  playheadSec: number,
  durationSec: number,
): string {
  const forceHours = hoursLayout(durationSec);
  return `${formatTime(playheadSec, { forceHours })} / ${formatTime(durationSec, { forceHours })}`;
}

/**
 * Narrow transport: playhead only (shorter). Pass duration so hour layout matches episode length.
 * Full pair stays available via formatTimecodePair for tooltips.
 */
export function formatTimecodeCompact(
  playheadSec: number,
  durationSec = playheadSec,
): string {
  return formatTime(playheadSec, { forceHours: hoursLayout(durationSec) });
}

export type TransportTimecode = {
  /** Playhead, in the episode's digit layout. */
  current: string;
  /** Episode duration, same layout. */
  total: string;
  /** `current / total` for tooltips. */
  title: string;
};

/** Everything a transport Timecode needs, from one playhead and duration. */
export function transportTimecode(
  playheadSec: number,
  durationSec: number,
): TransportTimecode {
  return {
    current: formatTimecodeCompact(playheadSec, durationSec),
    total: formatTime(durationSec, { forceHours: hoursLayout(durationSec) }),
    title: formatTimecodePair(playheadSec, durationSec),
  };
}

export function formatTimeShort(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatDurationCompact(sec: number): string {
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  if (sec >= 10) {
    return `${Math.round(sec)}s`;
  }
  return `${sec.toFixed(1)}s`;
}

/** Ruler steps (s), from 0.1 ms to an hour. */
const NICE_TIME_STEPS = [
  0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/** Pick a nice major tick step so labels are ~minPx apart. */
export function niceTimeStep(zoomPxPerSec: number, minPx = 70): number {
  const needSec = minPx / Math.max(zoomPxPerSec, 0.001);
  for (const step of NICE_TIME_STEPS) {
    if (step >= needSec) {
      return step;
    }
  }
  return NICE_TIME_STEPS[NICE_TIME_STEPS.length - 1]!;
}

/**
 * Relative slack for `formatRulerTime(..., "floor")`: a few ULPs of the scaled
 * value, so `0.29 * 100 = 28.999999999999996` still floors to 29, while
 * 59.9999995 s at a 1 s step floors to 59, not 60.
 */
const FLOOR_UNIT_EPSILON = 4 * Number.EPSILON;

/**
 * Ruler label for a tick (or the ruler's slider value): `m:ss` for whole-second
 * steps, else `m:ss.fff` (`h:mm:ss…` past an hour) with `ceil(−log10 step)`
 * decimals, at most 4, so a 0.5 ms step reads `0:01.2345`, a 0.5 s step
 * `0:02.5` and a 2 s step `0:02`. Tick labels round (ticks sit on float
 * multiples of the step); `"floor"` truncates for a position readout, like a
 * transport clock, so 59.68 s at a 1 s step reads `0:59`, not `1:00`.
 */
export function formatRulerTime(
  sec: number,
  step: number,
  mode: "round" | "floor" = "round",
): string {
  const decimals = Math.min(
    4,
    Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)),
  );
  const scale = 10 ** decimals;
  const scaled = Math.max(0, sec) * scale;
  const units =
    mode === "floor"
      ? Math.floor(scaled + FLOOR_UNIT_EPSILON * Math.max(1, scaled))
      : Math.round(scaled);
  const whole = Math.floor(units / scale);
  const frac =
    decimals > 0 ? `.${String(units % scale).padStart(decimals, "0")}` : "";
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = `${String(whole % 60).padStart(2, "0")}${frac}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
