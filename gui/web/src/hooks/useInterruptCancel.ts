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

export function useInterruptCancel(cancel: () => void, enabled = true) {
  const onInterrupt = useEffectEvent(cancel);
  useEffect(() => {
    if (!enabled) return;
    const watch = new AbortController();
    listenForInterrupt(onInterrupt, watch.signal);
    return () => watch.abort();
  }, [enabled]);
}
