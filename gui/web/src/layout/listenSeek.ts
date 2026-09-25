import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";

export function seekListen(sec: number): void {
  void execute("transport.seek", { sec }, { skipWhen: true });
}

/** Seek from the playhead as it is at click time: back stops at 0, forward
 *  at the session end. */
export function skipListen(deltaSec: number, durationSec: number): void {
  const next = useDawStore.getState().playheadSec + deltaSec;
  seekListen(deltaSec < 0 ? Math.max(0, next) : Math.min(durationSec, next));
}
