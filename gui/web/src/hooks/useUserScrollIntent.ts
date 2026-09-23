/**
 * Distinguish user scrolls from programmatic ones by input, not by timing.
 *
 * Programmatic writes (follow centering, virtualizer re-measure adjustments,
 * pane resizes) fire `scroll` without any preceding wheel / touch / scrollbar
 * / scroll-key input, so a timed "programmatic" flag cannot cover them all.
 * Spread `handlers` on the scroll container and call `isUserScroll()` from
 * `onScroll`.
 */

import type { KeyboardEvent, PointerEvent } from "react";
import { useCallback, useMemo, useRef } from "react";

/** How long one input keeps subsequent scroll events attributed to the user. */
export const USER_SCROLL_INTENT_MS = 600;

/** Keys that scroll a container from anywhere inside it. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);
/** Keys that only scroll when the container itself has focus. */
const CONTAINER_SCROLL_KEYS = new Set([" ", "ArrowUp", "ArrowDown"]);

export function isScrollKey(key: string, onContainer: boolean): boolean {
  return (
    SCROLL_KEYS.has(key) || (onContainer && CONTAINER_SCROLL_KEYS.has(key))
  );
}

export interface UserScrollIntentHandlers {
  onWheel: () => void;
  onTouchStart: () => void;
  onTouchMove: () => void;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

export function useUserScrollIntent(): {
  handlers: UserScrollIntentHandlers;
  isUserScroll: () => boolean;
} {
  const untilRef = useRef(Number.NEGATIVE_INFINITY);

  const arm = useCallback(() => {
    untilRef.current = performance.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handlers = useMemo<UserScrollIntentHandlers>(
    () => ({
      onWheel: arm,
      onTouchStart: arm,
      onTouchMove: arm,
      // Scrollbar drags target the container itself; clicks on children
      // (word seeks) must not count, or the follow scroll they cause unlocks.
      onPointerDown: (e) => {
        if (e.target === e.currentTarget) {
          arm();
        }
      },
      onKeyDown: (e) => {
        if (isScrollKey(e.key, e.target === e.currentTarget)) {
          arm();
        }
      },
    }),
    [arm],
  );

  const isUserScroll = useCallback(
    () => performance.now() < untilRef.current,
    [],
  );

  return { handlers, isUserScroll };
}
