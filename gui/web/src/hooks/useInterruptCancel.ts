import { useEffect, useEffectEvent } from "react";

export function useInterruptCancel(cancel: () => void, enabled = true) {
  const onInterrupt = useEffectEvent(cancel);
  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onInterrupt();
    };
    window.addEventListener("blur", onInterrupt);
    window.addEventListener("pagehide", onInterrupt);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onInterrupt);
      window.removeEventListener("pagehide", onInterrupt);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
}
