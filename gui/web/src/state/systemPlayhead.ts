import { useDawStore } from "./dawStore";

/** Copies the audio clock's second into the store without a seek (the store lags it while frames are paused). */
export function syncPlayhead(sec: number): void {
  useDawStore.getState().setPlayheadSec(sec, "playback");
}

/**
 * The sound stopped without a listener's command (the OS paused it, a call
 * came in, the episode ended). It writes through the setters, not a command, so
 * it does not end a Follow.
 */
export function pauseFromSystem(atSec: number): void {
  const state = useDawStore.getState();
  if (!state.isPlaying || state.sourcePreview) return;
  state.setPlayheadSec(atSec, "playback");
  state.setIsPlaying(false);
}
