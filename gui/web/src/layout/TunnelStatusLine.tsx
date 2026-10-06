import { useEffect, useState } from "react";
import type { TunnelStatus } from "../types/tunnel";
import {
  ONLINE_SHARING_GUIDE_URL,
  retryAtClock,
  retryCountdown,
  tunnelStatusCopy,
} from "./tunnelStatusCopy";

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

/** A ticking countdown to `retryAt`, or the static clock time under reduced motion. */
function useRetryText(retryAt: number | null): string | null {
  const reduce = prefersReducedMotion();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null || reduce) {
      return;
    }
    const update = () => setNow(Date.now());
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [retryAt, reduce]);
  if (retryAt === null) {
    return null;
  }
  return reduce ? retryAtClock(retryAt) : retryCountdown(retryAt, now);
}

/** Share dialog line: can guests open this host's links right now, and what to do if not. */
export function TunnelStatusLine({ status }: { status: TunnelStatus }) {
  const copy = tunnelStatusCopy(status);
  const retry = useRetryText(
    status.state === "reconnecting" ? status.retry_at : null,
  );
  if (!copy) {
    return null;
  }
  return (
    <div className="share-tunnel" data-tone={copy.tone}>
      <p className="share-tunnel-headline" role="status">
        <span className="share-tunnel-dot" aria-hidden="true" />
        {copy.headline}
      </p>
      {retry ? <p className="share-tunnel-retry">{retry}</p> : null}
      {copy.fix ? (
        <details className="share-tunnel-fix">
          <summary>{copy.fix.summary}</summary>
          <p>{copy.fix.body}</p>
          <a href={ONLINE_SHARING_GUIDE_URL} target="_blank" rel="noreferrer">
            Online sharing guide{" "}
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </details>
      ) : null}
    </div>
  );
}
