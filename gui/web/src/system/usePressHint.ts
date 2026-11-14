import { useCallback, useEffect, useRef, useState } from "react";

const HINT_MS = 2000;

/** A line that shows for two seconds after a press, for a control that cannot say it by itself. */
export function usePressHint() {
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
    timer.current = window.setTimeout(() => setShown(false), HINT_MS);
  }, []);
  return { shown, show, hide };
}
