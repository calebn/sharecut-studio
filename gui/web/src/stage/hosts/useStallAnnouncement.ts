import { useEffect, useRef, useState } from "react";
import { staleUpdateLabel } from "../../utils/pipelineProgress";

export const PROGRESS_STALLED = "Progress stalled";
export const PROGRESS_RESUMED = "Progress resumed";

type Update = { running: boolean; lastProgressAt: number | null | undefined };

/**
 * One-shot stall/resume announcement for the Deliver progress rows (export,
 * bounce). Feeds `StatusLiveRegion`: speaks only when a running job turns stale
 * or stops being stale, never on mount, never again while the state holds, so
 * the ticking "last update Ns ago" text is not re-read each second.
 */
export function useStallAnnouncement(
  updates: readonly Update[],
  nowSec: number,
): { message: string; seq: number } {
  const stale = updates.some(
    (u) => u.running && staleUpdateLabel(u.lastProgressAt, nowSec) !== null,
  );
  const was = useRef(stale);
  const [live, setLive] = useState({ message: "", seq: 0 });
  useEffect(() => {
    if (stale === was.current) {
      return;
    }
    was.current = stale;
    setLive((p) => ({
      message: stale ? PROGRESS_STALLED : PROGRESS_RESUMED,
      seq: p.seq + 1,
    }));
  }, [stale]);
  return live;
}
