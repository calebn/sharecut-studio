import { useDaw } from "../state/useDaw";
import { type MuteState, trackMuteState } from "../utils/audio";

/**
 * How this listener hears one track, for every surface that shows it: the
 * M button, the track header row and the timeline lane.
 */
export function useTrackMuteState(
  trackId: string,
  savedMute: boolean,
): MuteState {
  return useDaw((s) =>
    trackMuteState(trackId, savedMute, s.viewerMute, s.soloTracks),
  );
}
