import { useCallback, useEffect, useRef, useState } from "react";

const HINT_MS = 2000;

export function usePressHint(durationMs: number = HINT_MS) {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setShown(false);
  }, []);
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    setShown(true);
    timer.current = window.setTimeout(() => setShown(false), durationMs);
  }, [durationMs]);
  return { shown, show, hide };
}
