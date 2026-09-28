import { useEffect, useState } from "react";

/**
 * Re-renders the caller every `periodMs` while `active`, for values read from
 * a clock at render time (staleness checks, elapsed timers). Returns the tick
 * count. Inactive, it schedules nothing and never re-renders on its own.
 * useNowSec builds on it; use this hook for any new clock-driven re-render
 * instead of another setInterval.
 */
export function useIntervalTick(periodMs: number, active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = window.setInterval(() => setTick((n) => n + 1), periodMs);
    return () => window.clearInterval(id);
  }, [periodMs, active]);
  return tick;
}
