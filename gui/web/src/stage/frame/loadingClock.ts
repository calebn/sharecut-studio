import { useEffect, useState } from "react";

/** A screen that mounts within this long of the last one leaving carries on its count. */
const HANDOFF_MS = 250;

let started = 0;
let holders = 0;
let leftAt = Number.NEGATIVE_INFINITY;

const continues = (at: number) => holders > 0 || at - leftAt <= HANDOFF_MS;

/** Tests only: no screen is held and none just left. */
export function resetLoadingClockForTests() {
  started = 0;
  holders = 0;
  leftAt = Number.NEGATIVE_INFINITY;
}

/**
 * How long the review link has been loading, for a loading screen's first
 * render. The page swaps one loading screen for another (the Suspense fallback
 * takes over from the screen before it), and a count that began again at each
 * mount would put the blocks back to blank and push "Still loading…" off.
 * A screen that mounts while another is held, or just after the last one
 * left, continues that count; any other mount starts one.
 */
export function useLoadingClock(): number {
  const [{ begin, waited }] = useState(() => {
    const at = Date.now();
    const begin = continues(at) ? started : at;
    return { begin, waited: at - begin };
  });
  useEffect(() => {
    started = begin;
    holders += 1;
    return () => {
      holders -= 1;
      leftAt = Date.now();
    };
  }, [begin]);
  return waited;
}
