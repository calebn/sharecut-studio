import { useCallback, useEffect, useMemo, useRef } from "react";
import { listenForDragInterrupt } from "./useInterruptCancel";

export function useDragInterruptWatch() {
  const watch = useRef<AbortController | null>(null);
  const stop = useCallback(() => {
    watch.current?.abort();
    watch.current = null;
  }, []);
  const start = useCallback(
    (cancel: () => void) => {
      stop();
      watch.current = new AbortController();
      listenForDragInterrupt(cancel, watch.current.signal);
    },
    [stop],
  );
  useEffect(() => stop, [stop]);
  return useMemo(() => ({ start, stop }), [start, stop]);
}
