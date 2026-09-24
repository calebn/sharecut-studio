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

/** Pick a nice major tick step so labels are ~minPx apart. */
export function niceTimeStep(zoomPxPerSec: number, minPx = 70): number {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const needSec = minPx / Math.max(zoomPxPerSec, 0.001);
  for (const step of candidates) {
    if (step >= needSec) {
      return step;
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * Major ruler ticks for [0, durationSec] (session or visible canvas).
 * Never emits a tick past duration (avoids left-aligned end labels stretching layout).
 */
export function rulerTickTimes(
  durationSec: number,
  zoomPxPerSec: number,
  minPx = 70,
): number[] {
  if (!(durationSec > 0) || !(zoomPxPerSec > 0)) {
    return durationSec > 0 ? [0] : [];
  }
  const majorStep = niceTimeStep(zoomPxPerSec, minPx);
  const ticks: number[] = [];
  for (let t = 0; t <= durationSec + 1e-9; t += majorStep) {
    ticks.push(Number(t.toFixed(6)));
  }
  // Floating error may land slightly past duration — drop those; never force end.
  return ticks.filter((t) => t <= durationSec + 1e-6);
}
