import { livePlayheadSec } from "../audio/livePlayhead";
import { seekTransport } from "./seek";

/** Seek from where the listener is at click time (the audio clock while
 *  playing, which a locked page's store playhead lags): back stops at 0,
 *  forward at the session end. */
export function skipListen(deltaSec: number, durationSec: number): void {
  const next = livePlayheadSec() + deltaSec;
  void seekTransport(
    deltaSec < 0 ? Math.max(0, next) : Math.min(durationSec, next),
  );
}
