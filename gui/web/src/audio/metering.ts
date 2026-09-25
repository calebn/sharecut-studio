/**
 * Pure DSP for input peak metering.
 *
 * The recording meter's job is overload protection, so everything here is
 * peak-oriented (see the metering reference in issue #170): a peak meter
 * answers "did anything get too hot," which is the question a person about
 * to record is asking. Kept pure so the math is unit-testable without an
 * AudioContext; the rAF loop lives in `usePeakMeter`, and the display-side
 * helpers (scale mapping, zones, formatting) live beside `ui/LevelMeter`.
 */
import { linearToDb } from "../utils/audio";

/**
 * Default clip-latch threshold in dBFS (sample peak).
 *
 * Why −1: sample peaks under-read inter-sample (true) peaks, and EBU R128
 * caps production true peak at −1 dBTP. Latching at −1 dBFS sample peak is
 * the conservative, literature-backed safety margin.
 */
export const DEFAULT_CLIP_DB = -1;
/** Bottom of the meter scale, dBFS. A peak hold below it is dropped. */
export const DEFAULT_METER_FLOOR_DB = -60;
/** Peak-hold fall rate: 20 dB over 1.5 s, the PPM fall ballistics (IEC 60268-10). */
export const PEAK_HOLD_FALL_DB_PER_SEC = 20 / 1.5;

/** Highest instantaneous sample magnitude, linear (0 for digital silence). */
export function peakLinear(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] ?? 0);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Highest instantaneous sample magnitude, in dBFS. Silence → −Infinity. */
export function peakDbFromSamples(samples: ArrayLike<number>): number {
  return linearToDb(peakLinear(samples));
}

export type PeakHoldOptions = {
  fallDbPerSec?: number;
  /** A hold that falls below this floor resets to −Infinity (hidden). */
  floorDb?: number;
};

/**
 * PPM-style peak hold: jumps instantly to a new higher peak, then falls at
 * `fallDbPerSec`. Transients are faster than the eye, so the meter remembers.
 * Never rises without a new peak (negative `dtMs` is treated as 0) and drops
 * to −Infinity once it passes `floorDb`.
 */
export function decayPeakHold(
  holdDb: number,
  levelDb: number,
  dtMs: number,
  {
    fallDbPerSec = PEAK_HOLD_FALL_DB_PER_SEC,
    floorDb = DEFAULT_METER_FLOOR_DB,
  }: PeakHoldOptions = {},
): number {
  const dt = Math.max(0, dtMs);
  const next =
    levelDb >= holdDb
      ? levelDb
      : Math.max(levelDb, holdDb - (fallDbPerSec * dt) / 1000);
  return next < floorDb ? Number.NEGATIVE_INFINITY : next;
}

/** One meter reading: the shape `LevelMeter` renders. */
export type MeterState = {
  /** Current sample-peak level, dBFS (−Infinity when silent). */
  levelDb: number;
  /** PPM-style peak hold, dBFS (−Infinity when nothing is held). */
  peakHoldDb: number;
  /** Latched once a frame's peak reaches the clip threshold. */
  clipped: boolean;
};

export const SILENT_METER: MeterState = {
  levelDb: Number.NEGATIVE_INFINITY,
  peakHoldDb: Number.NEGATIVE_INFINITY,
  clipped: false,
};

export type StepMeterOptions = PeakHoldOptions & {
  clipDb?: number;
};

/** Advance the meter by one analysed frame `dtMs` after the previous one. */
export function stepMeter(
  prev: MeterState,
  samples: ArrayLike<number>,
  dtMs: number,
  { clipDb = DEFAULT_CLIP_DB, ...hold }: StepMeterOptions = {},
): MeterState {
  const levelDb = peakDbFromSamples(samples);
  return {
    levelDb,
    peakHoldDb: decayPeakHold(prev.peakHoldDb, levelDb, dtMs, hold),
    clipped: prev.clipped || levelDb >= clipDb,
  };
}
