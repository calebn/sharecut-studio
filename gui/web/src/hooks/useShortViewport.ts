import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

export const SHORT_VIEWPORT_PX = 480;
export const SHORT_VIEWPORT_RECOVER_PX = 520;
export const SHORT_VIEWPORT_MQ = `(max-height: ${SHORT_VIEWPORT_PX / 16}rem)`;

const shown = new WeakMap<object, boolean>();

function visualIsShort(): boolean {
  const visual = window.visualViewport;
  if (visual?.height === undefined) return false;
  if (Math.abs((visual.scale ?? 1) - 1) > 0.01) {
    shown.set(visual, false);
    return false;
  }
  if (visual.height <= SHORT_VIEWPORT_PX) shown.set(visual, true);
  else if (visual.height >= SHORT_VIEWPORT_RECOVER_PX) shown.set(visual, false);
  return shown.get(visual) ?? false;
}

function readShort(): boolean {
  if (typeof window === "undefined") return false;
  if (visualIsShort()) return true;
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
