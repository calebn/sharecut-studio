/** How long the lane being followed keeps the follow target through overlap (s). */
export const LEAD_HOLD_SEC = 1;

/** Fraction of the panel height bounding where the followed line may sit unmoved. */
export const COMFORT_BAND: readonly [number, number] = [0.3, 0.7];

/** Where Follow puts a line that left the comfort band (fraction of panel height). */
export const FOLLOW_ANCHOR = 0.5;

export type FollowCandidate = {
  utteranceIndex: number;
  trackId: string;
  /** Element key of the audible active word, or null when only the utterance is active. */
  wordKey: string | null;
};

/** The lane Follow is on, and the playhead at which it last had an active line. */
export type FollowLead = { trackId: string; sec: number };

/**
 * The line Follow should track, or null to leave the scroll alone.
 *
 * Follow stays on one lane while that lane has an active line. When the lane
 * falls silent and another lane is active, the target is held for
 * {@link LEAD_HOLD_SEC} so a short interjection from the other speaker does
 * not flip the list between lanes. A seek (playhead outside the hold) switches
 * at once.
 */
export function pickFollowCandidate(
  candidates: readonly FollowCandidate[],
  prev: FollowLead | null,
  sec: number,
  holdSec = LEAD_HOLD_SEC,
): FollowCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  const best = (list: readonly FollowCandidate[]): FollowCandidate =>
    list.reduce((a, b) => {
      if ((a.wordKey != null) !== (b.wordKey != null)) {
        return a.wordKey != null ? a : b;
      }
      return b.utteranceIndex < a.utteranceIndex ? b : a;
    });
  if (prev) {
    const sameLane = candidates.filter((c) => c.trackId === prev.trackId);
    if (sameLane.length > 0) {
      return best(sameLane);
    }
    const elapsed = sec - prev.sec;
    if (elapsed >= 0 && elapsed < holdSec) {
      return null;
    }
  }
  return best(candidates);
}

/**
 * New scrollTop that brings a line back into view, or null while the line
 * stays inside the comfort band. `itemTop` is relative to the scrollport top.
 */
export function followScrollTop(args: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  itemTop: number;
  itemHeight: number;
}): number | null {
  const { scrollTop, clientHeight, scrollHeight, itemTop, itemHeight } = args;
  if (clientHeight <= 0) {
    return null;
  }
  const center = itemTop + itemHeight / 2;
  if (
    center >= clientHeight * COMFORT_BAND[0] &&
    center <= clientHeight * COMFORT_BAND[1]
  ) {
    return null;
  }
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  const next = Math.min(
    maxScroll,
    Math.max(0, scrollTop + center - clientHeight * FOLLOW_ANCHOR),
  );
  return Math.abs(next - scrollTop) < 1 ? null : next;
}

const EASE_MS = 240;

/**
 * Move `root` to `to`: eased, or at once under reduced motion or for a long
 * jump (a seek). Returns a cancel function.
 */
export function easeScrollTop(
  root: HTMLElement,
  to: number,
  reducedMotion: boolean,
): () => void {
  const from = root.scrollTop;
  if (reducedMotion || Math.abs(to - from) > root.clientHeight * 1.5) {
    root.scrollTop = to;
    return () => {};
  }
  const t0 = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / EASE_MS);
    const eased = 1 - (1 - t) ** 3;
    root.scrollTop = from + (to - from) * eased;
    if (t < 1) {
      raf = window.requestAnimationFrame(step);
    }
  };
  raf = window.requestAnimationFrame(step);
  return () => window.cancelAnimationFrame(raf);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
