import type { MuteState } from "../utils/audio";

/**
 * Row and lane classes per mute state. `muted` and `mute-implied` dim what
 * this listener doesn't hear; `mute-listen` and `mute-implied` draw dashed,
 * because only this listener hears it that way. A saved mute stays solid.
 */
export const MUTE_STATE_ROW_CLASS: Record<MuteState, string> = {
  saved: " muted",
  listen: " muted mute-listen",
  implied: " mute-implied",
  off: "",
};
