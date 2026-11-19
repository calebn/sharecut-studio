import { useEffect, useState } from "react";

const HOST_GONE_WAIT_MS = 60_000;

export function useHostGoneWait(hostGone: boolean): boolean {
  const [waited, setWaited] = useState(false);
  if (!hostGone && waited) {
    setWaited(false);
  }
  useEffect(() => {
    if (!hostGone) return undefined;
    const timer = window.setTimeout(() => setWaited(true), HOST_GONE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [hostGone]);
  return hostGone && waited;
}
