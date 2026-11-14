import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A button that answers a press: busy from the press until the attempt ends,
 * and for at least `minMs` so a refusal that comes back at once is still seen
 * and a screen reader can finish the word. Display only: a caller that
 * succeeds does not wait for it. Attempts the user did not press (`active`
 * with no press) are never busy.
 */
export function useHeldBusy(
  active: boolean,
  minMs: number,
): { busy: boolean; press: () => void } {
  const [pressed, setPressed] = useState(false);
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const press = useCallback(() => {
    window.clearTimeout(timer.current);
    setPressed(true);
    setHolding(true);
    timer.current = window.setTimeout(() => setHolding(false), minMs);
  }, [minMs]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Over: the attempt ended and the floor passed, so a later attempt nobody
  // pressed is not shown as busy.
  if (pressed && !active && !holding) {
    setPressed(false);
  }

  return { busy: pressed && (active || holding), press };
}
