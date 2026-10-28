/**
 * `mm:ss.mmm` (`hh:mm:ss.mmm` from an hour or when forced), rounded to the
 * millisecond it shows so 16.04 reads `00:16.040` and 59.9995 carries to
 * `01:00.000`. Negative input clamps to zero.
 */
export function formatTime(
  sec: number,
  opts?: { forceHours?: boolean },
): string {
  const totalMs = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const whole = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const tail = `${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  // Pad hours so playhead/duration share a fixed layout in the transport.
  return opts?.forceHours || h > 0
    ? `${String(h).padStart(2, "0")}:${tail}`
    : tail;
}

/** Episodes an hour or longer, as `formatTime` rounds them, lay every transport time out as hh:mm:ss. */
function hoursLayout(durationSec: number): boolean {
  return Math.round(Math.max(0, durationSec) * 1000) >= 3_600_000;
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

/**
 * `m:ss`, or `h:mm:ss` from one hour (elapsed timers, comment anchors), rounded
 * to the whole second it shows like every other time label, so 59.9995 s reads
 * `1:00` where the transport reads `01:00.000`. Negative input clamps to 0:00.
 */
export function formatTimeShort(sec: number): string {
  const total = Math.round(Math.max(0, sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Rounded human duration for clip labels, separate from timeline timecode. */
export function formatDurationLabel(sec: number): string {
  const totalSeconds = Math.max(0, Math.round(sec));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** Ruler steps (s), from 0.1 ms to a day. */
const NICE_TIME_STEPS = [
  0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600,
  43200, 86400,
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
 * Ruler label for a tick (or the ruler's slider value): `m:ss` for whole-second
 * steps, else `m:ss.fff` (`h:mm:ss…` past an hour) with `ceil(−log10 step)`
 * decimals, at most 4, so a 0.5 ms step reads `0:01.2345`, a 0.5 s step
 * `0:02.5` and a 2 s step `0:02`. Rounds to the places it shows, as every time
 * label does (see `formatTime`), so 59.68 s at a 1 s step reads `1:00`.
 */
export function formatRulerTime(sec: number, step: number): string {
  const decimals = Math.min(
    4,
    Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)),
  );
  const scale = 10 ** decimals;
  const units = Math.round(Math.max(0, sec) * scale);
  const whole = Math.floor(units / scale);
  const frac =
    decimals > 0 ? `.${String(units % scale).padStart(decimals, "0")}` : "";
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = `${String(whole % 60).padStart(2, "0")}${frac}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function clockLabel(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) {
    return "?";
  }
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const remText = rem.toFixed(1).padStart(4, "0");
  if (m >= 60) {
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${remText}`;
  }
  return `${m}:${remText}`;
}

/** `m:ss.mmm` (`h:mm:ss.mmm` from an hour): a precise time for inspector fields. */
export function formatTimeMs(sec: number): string {
  return formatRulerTime(sec, 0.001);
}

const TIMECODE_FIELD = /^(\d+(\.\d*)?|\.\d+)$/;

/**
 * Parse `m:ss.mmm`, `h:mm:ss.mmm` or plain seconds to seconds; null when the
 * text is not one of those. Only the last field may carry a fraction, and
 * seconds (with minutes, from three fields) stay under 60.
 */
export function parseTimecode(text: string): number | null {
  const fields = text.trim().split(":");
  if (fields.length > 3 || !fields.every((f) => TIMECODE_FIELD.test(f))) {
    return null;
  }
  const last = fields.length - 1;
  for (let i = 0; i < last; i++) {
    if (fields[i]!.includes(".")) {
      return null;
    }
  }
  if (fields.length >= 2 && Number(fields[last]) >= 60) {
    return null;
  }
  if (fields.length === 3 && Number(fields[1]) >= 60) {
    return null;
  }
  return fields.reduce((acc, f) => acc * 60 + Number(f), 0);
}

/**
 * Clamp a session time to `[0, durationSec]`. The upper clamp is skipped
 * while the duration is unknown (not finite, e.g. before the project loads).
 */
export function clampToSession(raw: number, durationSec: number): number {
  return Number.isFinite(durationSec)
    ? Math.max(0, Math.min(durationSec, raw))
    : Math.max(0, raw);
}

/** Compact duration for status announcements (e.g. "1:00", "0.5s"). */
export function formatIngestDuration(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 59.95) {
    return `${Math.round(s * 10) / 10}s`;
  }
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
