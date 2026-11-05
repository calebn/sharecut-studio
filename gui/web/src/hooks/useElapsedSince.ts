import { useEffect, useState, useSyncExternalStore } from "react";
import { createElapsedSample } from "./sampledClocks";

export function useElapsedSince(startMs: number | null, active: boolean) {
  const [clock] = useState(createElapsedSample);
  const nowMs = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  useEffect(() => {
    clock.setStart(startMs);
  }, [clock, startMs]);
  useEffect(() => clock.connect(active), [clock, active]);
  return startMs === null ? 0 : Math.max(0, nowMs - startMs);
}
