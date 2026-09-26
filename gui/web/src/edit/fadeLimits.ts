/** Longest edge fade (ms) a clip may take: the track's cap (null = uncapped) and the clip length. */
export function maxFadeMs(
  clipDurationSec: number,
  trackFadeMaxMs?: number | null,
): number {
  const clipMs = Math.max(0, Math.floor(clipDurationSec * 1000));
  return trackFadeMaxMs == null
    ? clipMs
    : Math.max(0, Math.min(trackFadeMaxMs, clipMs));
}

/** Round to whole ms and clamp into [0, maxMs]. */
export function clampFadeMs(ms: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(0, Math.round(ms)));
}
