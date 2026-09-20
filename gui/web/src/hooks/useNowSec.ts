import { useEffect, useState } from "react";

/** Wall-clock seconds, ticking once a second while `enabled`. */
export function useNowSec(enabled: boolean): number {
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNowSec(Date.now() / 1000);
    const id = window.setInterval(() => {
      setNowSec(Date.now() / 1000);
    }, 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return nowSec;
}
