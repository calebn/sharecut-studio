import { useEffect, useState } from "react";
import { loadTunnelStatus } from "../../api/tunnelStatus";
import type { TunnelStatus } from "../../types/tunnel";

export const TUNNEL_STATUS_POLL_MS = 5000;

type StatusRead = {
  owner: { enabled: boolean };
  status: TunnelStatus | null;
};

/** Poll the tunnel status while `enabled`; null until the first answer or when it is unreachable. */
export function useTunnelStatus(enabled: boolean): TunnelStatus | null {
  const [read, setRead] = useState<StatusRead>(() => ({
    owner: { enabled },
    status: null,
  }));
  const { owner } = read;
  if (owner.enabled !== enabled) {
    setRead({ owner: { enabled }, status: null });
  }

  useEffect(() => {
    if (!owner.enabled) return;
    let cancelled = false;
    const refresh = () => {
      loadTunnelStatus().then(
        (next) => {
          if (!cancelled) {
            setRead((current) =>
              current.owner === owner ? { owner, status: next } : current,
            );
          }
        },
        () => {
          if (!cancelled) {
            setRead((current) =>
              current.owner === owner ? { owner, status: null } : current,
            );
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
  }, [owner]);

  return enabled ? read.status : null;
}
