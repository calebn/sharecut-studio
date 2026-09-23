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

/** Whether a track should be audible given project mute + viewer mute/solo. */
export function trackIsAudible(
  trackId: string,
  projectMuted: boolean,
  viewerMute: Record<string, boolean>,
  soloTracks: Record<string, boolean>,
): boolean {
  if (anySolo(soloTracks)) {
    return Boolean(soloTracks[trackId]) && !viewerMute[trackId];
  }
  return !projectMuted && !viewerMute[trackId];
}
