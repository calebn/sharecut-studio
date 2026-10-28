import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

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

export function useShortViewport(): boolean {
  return useMediaQueryStore(subscribeShort, readShort, () => false);
}
