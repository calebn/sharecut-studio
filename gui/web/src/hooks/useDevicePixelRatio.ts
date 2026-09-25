import { useSyncExternalStore } from "react";

function currentDpr(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * Re-arm a `(resolution: <dpr>dppx)` query on every change: it fires when the
 * page moves to a screen with another DPR. Browser zoom also fires `resize`.
 */
function subscribeDpr(onChange: () => void): () => void {
  let media: MediaQueryList | null = null;
  const arm = () => {
    media?.removeEventListener?.("change", fire);
    media =
      typeof window.matchMedia === "function"
        ? window.matchMedia(`(resolution: ${currentDpr()}dppx)`)
        : null;
    media?.addEventListener?.("change", fire);
  };
  const fire = () => {
    arm();
    onChange();
  };
  arm();
  window.addEventListener("resize", onChange);
  return () => {
    media?.removeEventListener?.("change", fire);
    window.removeEventListener("resize", onChange);
  };
}

/** `window.devicePixelRatio`, kept live across browser zoom and screens. */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeDpr, currentDpr, () => 1);
}
