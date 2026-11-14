import { useEffect, useState } from "react";

/** True once `active` has stayed true for `ms`; false again the moment it clears. */
export function useStillBusy(active: boolean, ms: number): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (!active) {
      setStill(false);
      return;
    }
    const timer = window.setTimeout(() => setStill(true), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return active && still;
}
