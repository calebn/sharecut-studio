import { isFrozenReviewKey } from "../frozenReview";
import { isShareProjectKey } from "../shareMode";
import type { DawState } from "./types";

// Pure on the key: the proxy's loaded state flips while its manifest loads, and the proxy shifts pitch.
export function playbackSpeedAvailable(projectPath: string): boolean {
  return !(isShareProjectKey(projectPath) && !isFrozenReviewKey(projectPath));
}

// Presence shares only a scan: followers must not inherit the host's personal speed.
export function scanRate(
  s: Pick<DawState, "playbackRate" | "chosenPlaybackRate" | "projectPath">,
): number {
  return s.playbackRate === effectiveChosen(s) ? 1 : s.playbackRate;
}

// The speed Play, Pause, Stop and a finished scan return to.
export function effectiveChosen(
  s: Pick<DawState, "chosenPlaybackRate" | "projectPath">,
): number {
  return playbackSpeedAvailable(s.projectPath) ? s.chosenPlaybackRate : 1;
}
