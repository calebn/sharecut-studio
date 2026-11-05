import { useEffect, useState } from "react";

export function startInterval(
  periodMs: number,
  onTick: () => void,
): () => void {
  let active = true;
  const id = window.setInterval(() => {
    if (active) onTick();
  }, periodMs);
  return () => {
    if (!active) return;
    active = false;
    window.clearInterval(id);
  };
}

/**
 * Retained counter advancing every periodMs while active. Inactive schedules
 * nothing.
 */
export function useIntervalTick(periodMs: number, active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    return startInterval(periodMs, () => setTick((n) => n + 1));
  }, [periodMs, active]);
  return tick;
}
