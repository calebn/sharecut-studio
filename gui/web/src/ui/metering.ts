/**
 * Display-side helpers for `LevelMeter`: scale mapping, color zones and
 * dBFS formatting. The DSP (peak detection, hold ballistics, clip latch)
 * lives in `audio/metering.ts`.
 */
import { DEFAULT_METER_FLOOR_DB } from "../audio/metering";

export const DEFAULT_WARN_DB = -12;
export const DEFAULT_DANGER_DB = -6;
export const DEFAULT_MIN_DB = DEFAULT_METER_FLOOR_DB;

export type MeterZone = "ok" | "warn" | "danger";

/** Map dBFS onto 0..1 across [minDb, 0]. Meters are dB-linear by convention. */
export function dbToFraction(
  db: number,
  minDb: number = DEFAULT_MIN_DB,
): number {
  if (!Number.isFinite(db)) return 0;
  const frac = (db - minDb) / -minDb;
  return Math.min(1, Math.max(0, frac));
}

/**
 * `aria-valuenow` must stay inside [minDb, 0]; the true reading (e.g. a
 * +0.5 dBFS float overshoot or −72 dBFS room tone) goes in `aria-valuetext`.
 */
export function ariaValueNow(
  levelDb: number,
  minDb: number = DEFAULT_MIN_DB,
): number {
  if (!Number.isFinite(levelDb)) return minDb;
  return Math.min(0, Math.max(minDb, Math.round(levelDb)));
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

/** Human-readable dBFS for numeric readouts and aria text. */
export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "-∞ dBFS";
  return `${Math.round(db)} dBFS`;
}
