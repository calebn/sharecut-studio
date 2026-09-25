import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

function currentDpr(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * A `(resolution: <dpr>dppx)` query through `mediaQuerySubscription`,
 * re-armed for the new DPR on every change: it fires when the page moves to
 * a screen with another DPR. Browser zoom also fires `resize`.
 */
function subscribeDpr(onChange: () => void): () => void {
  let disarm = () => {};
  const arm = () => {
    disarm();
    disarm = mediaQuerySubscription([`(resolution: ${currentDpr()}dppx)`])(
      fire,
    );
  };
  const fire = () => {
    arm();
    onChange();
  };
  arm();
  window.addEventListener("resize", onChange);
  return () => {
    disarm();
    window.removeEventListener("resize", onChange);
  };
}

/** `window.devicePixelRatio`, kept live across browser zoom and screens. */
export function useDevicePixelRatio(): number {
  return useMediaQueryStore(subscribeDpr, currentDpr, () => 1);
}
