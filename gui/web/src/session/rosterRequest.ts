/**
 * One outstanding `RosterRequest` at a time, retried until a full roster (`Presence`)
 * answers it. A `PresenceDelta` landing on a stale/unknown version asks for a resync
 * (`presence/roster.ts`'s `applyPresenceDelta`); this is what actually sends that
 * `RosterRequest` frame and keeps asking until `onRosterReceived` clears it.
 */
export interface RosterRequester {
  /** Send a `RosterRequest` now, unless one is already outstanding. */
  request: () => void;
  /** Call when a full roster (`Presence`) frame arrives: clears the outstanding request. */
  onRosterReceived: () => void;
  /** Stop retrying (socket closed / effect cleanup). */
  dispose: () => void;
}

export function createRosterRequester(
  send: (frame: Record<string, unknown>) => unknown,
  retryMs = 2000,
): RosterRequester {
  let timer: number | null = null;
  let outstanding = false;

  const clearTimer = () => {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const fire = () => {
    outstanding = true;
    send({ type: "RosterRequest" });
    clearTimer();
    timer = window.setTimeout(fire, retryMs);
  };

  return {
    request: () => {
      if (outstanding) {
        return;
      }
      fire();
    },
    onRosterReceived: () => {
      outstanding = false;
      clearTimer();
    },
    dispose: () => {
      outstanding = false;
      clearTimer();
    },
  };
}
