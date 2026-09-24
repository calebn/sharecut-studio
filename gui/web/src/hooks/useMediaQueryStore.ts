import { useSyncExternalStore } from "react";

type SubscribeExtra = (onChange: () => void) => () => void;

/** Subscribe to browser capability changes, with optional non-media signals. */
export function mediaQuerySubscription(
  queries: readonly string[],
  subscribeExtra?: SubscribeExtra,
): (onChange: () => void) => () => void {
  return (onChange) => {
    const media =
      typeof globalThis.matchMedia === "function"
        ? queries.map((query) => globalThis.matchMedia(query))
        : [];
    for (const query of media) {
      query.addEventListener("change", onChange);
    }
    const unsubscribeExtra = subscribeExtra?.(onChange);
    return () => {
      for (const query of media) {
        query.removeEventListener("change", onChange);
      }
      unsubscribeExtra?.();
    };
  };
}

/** Read a live media-derived snapshot with a stable first render. */
export function useMediaQueryStore<T>(
  subscribe: (onChange: () => void) => () => void,
  getSnapshot: () => T,
  getServerSnapshot: () => T,
): T {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
