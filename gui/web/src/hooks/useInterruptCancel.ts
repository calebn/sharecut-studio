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

export function listenForRotation(cancel: () => void, signal: AbortSignal) {
  let width = window.innerWidth;
  window.addEventListener(
    "resize",
    () => {
      if (window.innerWidth === width) return;
      width = window.innerWidth;
      cancel();
    },
    { signal },
  );
  window.addEventListener("orientationchange", cancel, { signal });
}

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
