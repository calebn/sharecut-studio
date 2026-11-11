// A fade set by hand is bounded by its clip only, as `join_modes.clamp_clip_fades`
// bounds it: the Longest automatic join fade limits automatic join fades, never these.

/** Longest edge fade (ms) a clip may take: its length in whole ms (floored, never negative), as `join_modes.clamp_clip_fades` computes it. */
export function maxFadeMs(clipDurationSec: number): number {
  return Math.max(0, Math.floor(clipDurationSec * 1000));
}

/** Round to whole ms and clamp into [0, maxMs]. */
export function clampFadeMs(ms: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(0, Math.round(ms)));
}

/**
 * Longest fade one edge may take when the other edge already takes
 * `otherEdgeMs`: the clip length minus the other fade, so the two never overlap.
 */
export function edgeFadeMaxMs(
  clipDurationSec: number,
  otherEdgeMs: number,
): number {
  return Math.max(0, maxFadeMs(clipDurationSec) - Math.max(0, otherEdgeMs));
}

/**
 * Longest join length (ms) `SetClipJoin` keeps on both edges: the left clip's
 * fade-out is bounded by what its fade-in leaves, and the right clip's fade-in by
 * its length (`join_modes.set_clip_join` clamps fade-in first).
 * Pinned to the server by contracts/join-length-limits.json.
 */
export function joinLengthMaxMs(
  left: { durationSec: number; fadeInMs: number },
  right: { durationSec: number },
): number {
  const leftInMs = clampFadeMs(left.fadeInMs, maxFadeMs(left.durationSec));
  return Math.min(
    edgeFadeMaxMs(left.durationSec, leftInMs),
    maxFadeMs(right.durationSec),
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
): { inMs: number; outMs: number } {
  const nextIn = clampFadeMs(inMs, maxFadeMs(clipDurationSec));
  return {
    inMs: nextIn,
    outMs: clampFadeMs(outMs, edgeFadeMaxMs(clipDurationSec, nextIn)),
  };
}
