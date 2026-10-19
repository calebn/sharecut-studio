import type { DawState } from "./types";

export type TransportAvailability = Readonly<{
  togglePlay: string | undefined;
  stop: string | undefined;
}>;

export function transportAvailability(
  state: Readonly<Pick<DawState, "project" | "isPlaying" | "playStartSec">>,
): TransportAvailability {
  if (state.project === null) {
    const reason = "Loading project…";
    return { togglePlay: reason, stop: reason };
  }
  if (state.project.tracks.length > 0 || state.isPlaying) {
    return { togglePlay: undefined, stop: undefined };
  }
  const reason = "Import audio to play.";
  return {
    togglePlay: reason,
    stop: state.playStartSec !== null ? undefined : reason,
  };
}
