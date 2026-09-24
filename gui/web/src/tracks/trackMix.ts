import type { TrackView } from "../types/project";

/** Fader range (dB), matching the server's FADER_MIN_DB / FADER_MAX_DB. */
export const FADER_MIN_DB = -60;
export const FADER_MAX_DB = 12;
export const FADER_STEP_DB = 0.5;

/** Gain the mix applies to a track: staging gain plus the user's fader. */
export function trackOutputGainDb(
  track: Pick<TrackView, "gain_db" | "fader_db">,
): number {
  return track.gain_db + (track.fader_db ?? 0);
}

/** Signed dB label: "+1.5 dB", "−3.0 dB", "0.0 dB". */
export function formatDb(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) {
    return "0.0 dB";
  }
  const sign = rounded > 0 ? "+" : "\u2212";
  return `${sign}${Math.abs(rounded).toFixed(1)} dB`;
}

export function clampFaderDb(db: number): number {
  return Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, db));
}
