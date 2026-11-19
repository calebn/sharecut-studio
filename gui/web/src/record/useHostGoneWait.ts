import { useEffect, useState } from "react";

export const HOST_GONE_WAIT_MS = 60_000;

export function useHostGoneWait(
  hostGone: boolean,
  waitMs: number = HOST_GONE_WAIT_MS,
): boolean {
  const [waited, setWaited] = useState(false);
  if (!hostGone && waited) {
    setWaited(false);
  }
  useEffect(() => {
    if (!hostGone) return undefined;
    const timer = window.setTimeout(() => setWaited(true), waitMs);
    return () => window.clearTimeout(timer);
  }, [hostGone, waitMs]);
  return hostGone && waited;
}
