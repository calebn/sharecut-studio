/**
 * Pure DSP helpers for input metering.
 *
 * The recording meter's job is overload protection, so everything here is
 * peak-oriented (see the metering reference in issue #170): a peak meter
 * answers "did anything get too hot," which is the question a person about
 * to record is asking. Kept pure so the math is unit-testable without an
 * AudioContext; the rAF/driver loop lives in `useInputPeakDb`.
 */

/** Default clip-latch threshold in dBFS (sample peak). */
export const DEFAULT_CLIP_DB = -1;
/**
 * Why −1: sample peaks under-read inter-sample (true) peaks, and EBU R128
 * caps production true peak at −1 dBTP. Latching at −1 dBFS sample peak is
 * the conservative, literature-backed safety margin.
 */
export const DEFAULT_WARN_DB = -12;
export const DEFAULT_DANGER_DB = -6;
export const DEFAULT_MIN_DB = -60;
/** Peak-hold fall rate: 20 dB over 1.5 s, the PPM fall ballistics (IEC 60268-10). */
export const PEAK_HOLD_FALL_DB_PER_SEC = 20 / 1.5;

export type MeterZone = "ok" | "warn" | "danger";

/** Highest instantaneous level of the samples, in dBFS. Silence → −Infinity. */
export function peakDbFromSamples(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] ?? 0);
    if (v > peak) peak = v;
  }
  if (peak <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(peak);
}

/** Map dBFS onto 0..1 across [minDb, 0]. Meters are dB-linear by convention. */
export function dbToFraction(
  db: number,
  minDb: number = DEFAULT_MIN_DB,
): number {
  if (!Number.isFinite(db)) return 0;
  const frac = (db - minDb) / -minDb;
  return Math.min(1, Math.max(0, frac));
}

/** Which color zone a dBFS reading falls in. */
export function zoneForDb(
  db: number,
  warnDb: number = DEFAULT_WARN_DB,
  dangerDb: number = DEFAULT_DANGER_DB,
): MeterZone {
  if (db >= dangerDb) return "danger";
  if (db >= warnDb) return "warn";
  return "ok";
}

/**
 * PPM-style peak hold: jumps instantly to a new higher peak, then falls at
 * `fallDbPerSec`. Transients are faster than the eye, so the meter remembers.
 */
export function decayPeakHold(
  holdDb: number,
  levelDb: number,
  dtMs: number,
  fallDbPerSec: number = PEAK_HOLD_FALL_DB_PER_SEC,
): number {
  if (levelDb >= holdDb) return levelDb;
  if (!Number.isFinite(holdDb)) return levelDb;
  if (!Number.isFinite(levelDb)) return holdDb - (fallDbPerSec * dtMs) / 1000;
  return Math.max(levelDb, holdDb - (fallDbPerSec * dtMs) / 1000);
}

/** Human-readable dBFS for numeric readouts and aria text. */
export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "-∞ dBFS";
  return `${Math.round(db)} dBFS`;
}
