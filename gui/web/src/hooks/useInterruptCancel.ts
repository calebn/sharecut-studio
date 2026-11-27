import { useEffect, useEffectEvent } from "react";

/** Calls `cancel` when the window loses focus, the page is hidden or the tab goes to the background, until `signal` aborts. */
export function listenForInterrupt(cancel: () => void, signal: AbortSignal) {
  window.addEventListener("blur", cancel, { signal });
  window.addEventListener("pagehide", cancel, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") cancel();
    },
    { signal },
  );
}

/** Calls `cancel` when the phone is rotated, until `signal` aborts: the layout width differs from when this started listening, or the browser reports an orientation change. A height-only resize (a keyboard, a collapsing address bar) does not call it, and one rotation can call it twice. */
export function listenForRotation(cancel: () => void, signal: AbortSignal) {
  const width = window.innerWidth;
  window.addEventListener(
    "resize",
    () => {
      if (window.innerWidth !== width) cancel();
    },
    { signal },
  );
  window.addEventListener("orientationchange", cancel, { signal });
}

/** Calls `cancel` when a drag in progress is interrupted by the page or by a rotation, until `signal` aborts. Start it when the drag starts, so the rotation width is the one the drag began with. */
export function listenForDragInterrupt(
  cancel: () => void,
  signal: AbortSignal,
) {
  listenForInterrupt(cancel, signal);
  listenForRotation(cancel, signal);
}

export function useInterruptCancel(cancel: () => void, enabled = true) {
  const onInterrupt = useEffectEvent(cancel);
  useEffect(() => {
    if (!enabled) return;
    const watch = new AbortController();
    listenForDragInterrupt(onInterrupt, watch.signal);
    return () => watch.abort();
  }, [enabled]);
}
