import type { TrackView } from "../types/project";

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/** Linear amplitude → dB. Non-positive (silent) input → −Infinity. */
export function linearToDb(linear: number): number {
  if (!(linear > 0)) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(linear);
}

/** `AudioContext`, falling back to Safari's prefixed `webkitAudioContext`. */
export function audioContextCtor(): typeof AudioContext | undefined {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext || w.webkitAudioContext;
}

export function anySolo(soloTracks: Record<string, boolean>): boolean {
  return Object.values(soloTracks).some(Boolean);
}

/**
 * How a track's M reads for this listener, strongest first: muted in the
 * saved mix (mute beats solo, as in Pro Tools), muted for this listener only,
 * or silenced because they soloed another track (an "implied" mute).
 */
export type MuteState = "saved" | "listen" | "implied" | "off";

export function trackMuteState(
  trackId: string,
  projectMuted: boolean,
  viewerMute: Record<string, boolean>,
  soloTracks: Record<string, boolean>,
): MuteState {
  if (projectMuted) {
    return "saved";
  }
  if (viewerMute[trackId]) {
    return "listen";
  }
  if (anySolo(soloTracks) && !soloTracks[trackId]) {
    return "implied";
  }
  return "off";
}

/** Whether this listener hears a track: only when nothing mutes it. */
export function trackIsAudible(
  trackId: string,
  projectMuted: boolean,
  viewerMute: Record<string, boolean>,
  soloTracks: Record<string, boolean>,
): boolean {
  return (
    trackMuteState(trackId, projectMuted, viewerMute, soloTracks) === "off"
  );
}

/** Saved volume range (dB), matching the server's FADER_MIN_DB / FADER_MAX_DB. */
export const FADER_MIN_DB = -60;
export const FADER_MAX_DB = 12;
export const FADER_STEP_DB = 0.5;

export function clampFaderDb(db: number): number {
  return Math.min(FADER_MAX_DB, Math.max(FADER_MIN_DB, db));
}

/** Gain the mix applies to a track: staging gain plus the saved volume. */
export function trackOutputGainDb(
  track: Pick<TrackView, "gain_db" | "fader_db">,
): number {
  return track.gain_db + (track.fader_db ?? 0);
}

/** Signed gain label: "+1.5 dB", "−3.0 dB", "0.0 dB". */
export function formatGainDb(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) {
    return "0.0 dB";
  }
  const sign = rounded > 0 ? "+" : "\u2212";
  return `${sign}${Math.abs(rounded).toFixed(1)} dB`;
}
