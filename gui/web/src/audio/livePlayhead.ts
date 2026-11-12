import { useDawStore } from "../state/dawStore";
import { playbackPositionSec } from "./playbackClock";

/**
 * Where the listener is now: the audio clock while a transport plays, else the
 * store playhead. A page without frames (locked, hidden) stops writing the
 * store, so only the audio clock is current there.
 */
export function livePlayheadSec(): number {
  return playbackPositionSec() ?? useDawStore.getState().playheadSec;
}
