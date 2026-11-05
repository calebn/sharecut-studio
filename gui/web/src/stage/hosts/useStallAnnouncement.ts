import { useEffect, useRef } from "react";
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

/**
 * One-shot stall/resume announcement for the Deliver progress rows (export,
 * bounce), spoken through the shell's one status channel via `announce`. It
 * speaks only when a running job turns stale or its updates return, never on
 * mount and never again while the state holds. A job that ends (finished,
 * cancelled, failed) resets silently: the frame's job-status announcement
 * already says so. A flapping heartbeat near the 15 s threshold speaks on each
 * transition; that chatter is accepted and documented.
 */
export function useStallAnnouncement(
  updates: readonly Update[],
  nowSec: number,
  announce: (message: string) => void,
): void {
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const prev = useRef<boolean[] | null>(null);
  useEffect(() => {
    const before = prev.current;
    const next = updates.map((u, i) =>
      !u.running
        ? false
        : u.tracked
          ? isStaleUpdate(u.lastProgressAt, nowSec)
          : (before?.[i] ?? false),
    );
    prev.current = next;
    if (before === null) {
      return;
    }
    const was = before.some(Boolean);
    const now = next.some(Boolean);
    if (!was && now) {
      announceRef.current(PROGRESS_STALLED);
    } else if (
      was &&
      !now &&
      updates.some((u, i) => before[i] && u.running && u.tracked)
    ) {
      announceRef.current(PROGRESS_RESUMED);
    }
  });
}
