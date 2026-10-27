import { seekTransport } from "../../commands/seek";
import { useDawStore } from "../../state/dawStore";

/** Seek from the playhead as it is at click time: back stops at 0, forward
 *  at the session end. */
export function skipListen(deltaSec: number, durationSec: number): void {
  const next = useDawStore.getState().playheadSec + deltaSec;
  void seekTransport(
    deltaSec < 0 ? Math.max(0, next) : Math.min(durationSec, next),
  );
}
