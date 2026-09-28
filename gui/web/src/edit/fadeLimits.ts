/** Clip length in whole ms (floored, never negative), as `join_modes.clamp_clip_fades` computes it. */
function clipLengthMs(clipDurationSec: number): number {
  return Math.max(0, Math.floor(clipDurationSec * 1000));
}

/** Longest edge fade (ms) a clip may take: the track's cap (null = uncapped) and the clip length. */
export function maxFadeMs(
  clipDurationSec: number,
  trackFadeMaxMs?: number | null,
): number {
  const clipMs = clipLengthMs(clipDurationSec);
  return trackFadeMaxMs == null
    ? clipMs
    : Math.max(0, Math.min(trackFadeMaxMs, clipMs));
}

/** Round to whole ms and clamp into [0, maxMs]. */
export function clampFadeMs(ms: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(0, Math.round(ms)));
}

/**
 * Longest fade one edge may take when the other edge already takes
 * `otherEdgeMs`: the track cap and the clip length, minus the other fade, so
 * the two never overlap.
 */
export function edgeFadeMaxMs(
  clipDurationSec: number,
  trackFadeMaxMs: number | null | undefined,
  otherEdgeMs: number,
): number {
  const clipMs = clipLengthMs(clipDurationSec);
  return Math.max(
    0,
    Math.min(
      maxFadeMs(clipDurationSec, trackFadeMaxMs),
      clipMs - Math.max(0, otherEdgeMs),
    ),
  );
}

/**
 * Longest join length (ms) `SetClipJoin` keeps on both edges: the left clip's
 * fade-out is bounded by what its fade-in leaves, and the right clip's fade-in by
 * the cap and its length (`join_modes.set_clip_join` clamps fade-in first).
 * Pinned to the server by contracts/join-length-limits.json.
 */
export function joinLengthMaxMs(
  left: { durationSec: number; fadeInMs: number },
  right: { durationSec: number },
  trackFadeMaxMs: number | null | undefined,
): number {
  // The server caps the left clip's stored fade-in first (clamp_clip_fades), then bounds the fade-out.
  const leftInMs = clampFadeMs(
    left.fadeInMs,
    maxFadeMs(left.durationSec, trackFadeMaxMs),
  );
  return Math.min(
    edgeFadeMaxMs(left.durationSec, trackFadeMaxMs, leftInMs),
    maxFadeMs(right.durationSec, trackFadeMaxMs),
  );
}

/**
 * Clamp both edge fades the way the server's `set_clip_fade` does
 * (`join_modes.clamp_clip_fades`): fade-in first, then fade-out to what it leaves.
 */
export function clampClipFades(
  inMs: number,
  outMs: number,
  clipDurationSec: number,
  trackFadeMaxMs: number | null | undefined,
): { inMs: number; outMs: number } {
  const nextIn = clampFadeMs(inMs, maxFadeMs(clipDurationSec, trackFadeMaxMs));
  return {
    inMs: nextIn,
    outMs: clampFadeMs(
      outMs,
      edgeFadeMaxMs(clipDurationSec, trackFadeMaxMs, nextIn),
    ),
  };
}
