import { useEffect, useState } from "react";
import { useIntervalTick } from "./useIntervalTick";

export function useElapsedSince(startMs: number | null, active: boolean) {
  const tick = useIntervalTick(1000, active);
  const [nowMs, setNowMs] = useState(() => performance.now());
  useEffect(() => {
    if (startMs !== null && tick >= 0) {
      setNowMs(performance.now());
    }
  }, [startMs, tick]);
  return startMs === null ? 0 : Math.max(0, nowMs - startMs);
}
