import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

/** Shorter than this (480px) a window cannot spare room for reading beside a composer. */
export const SHORT_VIEWPORT_PX = 480;
export const SHORT_VIEWPORT_MQ = `(max-height: ${SHORT_VIEWPORT_PX / 16}rem)`;

function readShort(): boolean {
  if (typeof window === "undefined") return false;
  const visual = window.visualViewport?.height;
  if (visual !== undefined && visual <= SHORT_VIEWPORT_PX) return true;
  return typeof window.matchMedia === "function"
    ? window.matchMedia(SHORT_VIEWPORT_MQ).matches
    : false;
}

const subscribeShort = mediaQuerySubscription(
  [SHORT_VIEWPORT_MQ],
  (onChange) => {
    window.addEventListener("resize", onChange);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      vv?.removeEventListener("resize", onChange);
    };
  },
);

/**
 * True on a very short window, such as a phone in landscape or with the
 * keyboard up. Follows the visual viewport too, which shrinks when the
 * keyboard opens even where the layout viewport does not.
 */
export function useShortViewport(): boolean {
  return useMediaQueryStore(subscribeShort, readShort, () => false);
}
