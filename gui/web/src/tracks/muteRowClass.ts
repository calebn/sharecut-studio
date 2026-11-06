import type { MuteState } from "../utils/audio";

/**
 * Track-mix row classes per mute state (lanes read `data-mute` instead, so the
 * state reaches the lane's own element). `muted` and `mute-implied` dim what
 * this listener doesn't hear; `mute-listen` and `mute-implied` draw dashed,
 * because only this listener hears it that way. A saved mute stays solid.
 */
export const MUTE_STATE_ROW_CLASS: Record<MuteState, string> = {
  saved: " muted",
  listen: " muted mute-listen",
  implied: " mute-implied",
  off: "",
};
