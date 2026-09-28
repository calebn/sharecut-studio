import { useEffect, useState } from "react";
import { useIntervalTick } from "./useIntervalTick";

/**
 * Wall-clock seconds, read on each once-a-second `useIntervalTick` beat while
 * `enabled`. Re-syncs as soon as `enabled` turns true and holds the last value
 * while disabled.
 */
export function useNowSec(enabled: boolean): number {
  const tick = useIntervalTick(1000, enabled);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (enabled) {
      setNowSec(Date.now() / 1000);
    }
  }, [enabled, tick]);
  return nowSec;
}
