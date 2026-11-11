import { useEffect, useState, useSyncExternalStore } from "react";
import { createWallSample } from "./sampledClocks";

export function useNowSec(enabled: boolean): number {
  const [clock] = useState(createWallSample);
  const nowSec = useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  useEffect(() => clock.connect(enabled), [clock, enabled]);
  return nowSec;
}
