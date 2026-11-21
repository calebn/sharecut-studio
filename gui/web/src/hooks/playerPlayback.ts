import { flushSync } from "react-dom";
import { runPointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";

export function stopSourcePreview(): void {
  const state = useDawStore.getState();
  state.setIsPlaying(false);
  state.stopFollow("local");
}

export function resumeEpisodeFromPreview(): void {
  // Guest proxy recovery listens for a committed false-to-true episode play edge.
  flushSync(() => useDawStore.getState().setIsPlaying(false));
  runPointerCommand("transport.togglePlay");
}

export function togglePlayerPlayback(): void {
  const previewPlaying = useDawStore.getState().sourcePreview?.playing;
  if (previewPlaying === undefined) runPointerCommand("transport.togglePlay");
  else if (previewPlaying) stopSourcePreview();
  else resumeEpisodeFromPreview();
}
