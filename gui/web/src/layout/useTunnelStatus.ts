import { useEffect, useState } from "react";
import { loadTunnelStatus } from "../api/tunnelStatus";
import type { TunnelStatus } from "../types/tunnel";

export const TUNNEL_STATUS_POLL_MS = 5000;

/** Poll the tunnel status while `enabled`; null until the first answer or when it is unreachable. */
export function useTunnelStatus(enabled: boolean): TunnelStatus | null {
  const [status, setStatus] = useState<TunnelStatus | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      loadTunnelStatus().then(
        (next) => {
          if (!cancelled) {
            setStatus(next);
          }
        },
        () => {
          if (!cancelled) {
            setStatus(null);
          }
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, TUNNEL_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return status;
}
