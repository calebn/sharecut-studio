export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
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
