import { useEffect, useRef, useState } from "react";
import { useNowSec } from "../hooks/useNowSec";
import { staleUpdateLabel } from "../utils/pipelineProgress";

type Props = {
  lastProgressAt: number | null | undefined;
  running: boolean;
  prefix?: string;
  announce?: boolean;
  /** Fixed wall-clock seconds for catalog previews; omit to tick live. */
  nowSec?: number;
};

/** Ticking stall copy owned by a tiny clock subtree — not a parent live region. */
export function StaleProgressCopy({
  lastProgressAt,
  running,
  prefix = "",
  announce = false,
  nowSec: fixedNowSec,
}: Props) {
  const liveNowSec = useNowSec(running && fixedNowSec === undefined);
  const nowSec = fixedNowSec ?? liveNowSec;
  const stale = running ? staleUpdateLabel(lastProgressAt, nowSec) : null;
  const wasStale = useRef(false);
  const [live, setLive] = useState("");

  useEffect(() => {
    if (!announce) {
      return;
    }
    const isStale = stale != null;
    if (isStale === wasStale.current) {
      return;
    }
    wasStale.current = isStale;
    setLive(isStale ? "Progress stalled" : "Progress resumed");
  }, [announce, stale]);

  if (!stale && !live) {
    return null;
  }
  return (
    <>
      {stale ? (
        <span className="pipeline-stale">
          {prefix}
          {stale}
        </span>
      ) : null}
      {announce && live ? (
        <span className="sr-only" aria-live="polite">
          {live}
        </span>
      ) : null}
    </>
  );
}
