import { useEffect, useLayoutEffect, useRef } from "react";
import { isStaleUpdate } from "../../utils/pipelineProgress";

export const PROGRESS_STALLED = "Progress stalled";
export const PROGRESS_RESUMED = "Progress resumed";

type Update = {
  running: boolean;
  /**
   * False when the single activity slot no longer holds this run's job (another
   * job took it): staleness is then unknown, not fresh, and nothing is said.
   */
  tracked: boolean;
  lastProgressAt: number | null | undefined;
};

type State = { stale: boolean; seenFresh: boolean };

/**
 * One-shot stall/resume announcement for the Deliver progress rows (export,
 * bounce), spoken through the shell's one status channel via `announce`.
 * A run can stall only after it was seen running and fresh at least once, so a
 * run that is stale from its first look (clock skew between client and Studio
 * host, or a mount while already stale) stays silent. "Resumed" is spoken only
 * when a stall was actually spoken. The hook speaks on the aggregate edge: a
 * second job going stale while another is already stale says nothing. A job
 * that ends (finished, cancelled, failed) resets silently. A flapping
 * heartbeat near the 15 s threshold speaks on each transition; accepted.
 */
export function useStallAnnouncement(
  updates: readonly Update[],
  nowSec: number,
  announce: (message: string) => void,
): void {
  const announceRef = useRef(announce);
  useLayoutEffect(() => {
    announceRef.current = announce;
  });
  const prev = useRef<State[] | null>(null);
  const spoken = useRef(false);
  useEffect(() => {
    const before = prev.current;
    const next = updates.map((u, i): State => {
      if (!u.running) {
        return { stale: false, seenFresh: false };
      }
      const was = before?.[i] ?? { stale: false, seenFresh: false };
      if (!u.tracked) {
        return was;
      }
      const stale = isStaleUpdate(u.lastProgressAt, nowSec);
      const fresh = u.lastProgressAt != null && !stale;
      return {
        stale: was.seenFresh && stale,
        seenFresh: was.seenFresh || fresh,
      };
    });
    prev.current = next;
    if (before === null) {
      return;
    }
    const was = before.some((s) => s.stale);
    const now = next.some((s) => s.stale);
    if (!was && now) {
      spoken.current = true;
      announceRef.current(PROGRESS_STALLED);
    } else if (was && !now) {
      const resumed = updates.some(
        (u, i) => before[i]?.stale && u.running && u.tracked,
      );
      if (resumed && spoken.current) {
        announceRef.current(PROGRESS_RESUMED);
      }
      spoken.current = false;
    }
  });
}
