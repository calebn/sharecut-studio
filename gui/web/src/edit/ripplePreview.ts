/**
 * Ripple during a trim drag (#1135): a trim ripples, so every later clip on
 * the track moves by the change in the trimmed clip's length. The drag shows
 * that live, as a held strip nudge does (`nudge.ts` `withNudge`), instead of
 * the later clips jumping on release.
 */
import type { ClipRow } from "../types/project";

export interface RipplePreview {
  /** The trimmed clip. */
  clipId: string;
  /** Its saved end: clips starting here or later ride along. */
  afterSec: number;
  /** How far they move (s). */
  deltaSec: number;
}

const SAME_SEC = 1e-9;

/** The ripple of trimming `clip` to `sourceStart`..`sourceEnd`, or null if none. */
export function rippleOf(
  clip: ClipRow,
  trimmed: { sourceStart: number; sourceEnd: number },
): RipplePreview | null {
  const deltaSec =
    trimmed.sourceEnd -
    trimmed.sourceStart -
    (clip.source_end - clip.source_start);
  return Math.abs(deltaSec) < SAME_SEC
    ? null
    : { clipId: clip.id, afterSec: clip.timeline_end, deltaSec };
}

/** Where each later clip in `lane` starts while `ripple` previews. */
export function rippledStarts(
  lane: readonly ClipRow[],
  ripple: RipplePreview | null,
): Readonly<Record<string, number>> {
  if (!ripple) return NONE;
  const out: Record<string, number> = {};
  for (const clip of lane) {
    if (
      clip.id !== ripple.clipId &&
      clip.timeline_start >= ripple.afterSec - 1e-6
    ) {
      out[clip.id] = clip.timeline_start + ripple.deltaSec;
    }
  }
  return out;
}

const NONE: Readonly<Record<string, number>> = Object.freeze({});

/** "later −6.7 s": how far a ripple moves the later clips. */
export function rippleDetail(deltaSec: number): string {
  const sign = deltaSec < 0 ? "−" : "+";
  return `later ${sign}${Math.abs(deltaSec).toFixed(1)} s`;
}
