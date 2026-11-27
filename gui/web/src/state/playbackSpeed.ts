import { isFrozenReviewKey } from "../frozenReview";
import { isShareProjectKey } from "../shareMode";
import type { DawState } from "./types";

export const SPEED_UNAVAILABLE_REASON =
  "Speed isn't available on live-episode links yet.";

export const FOLLOWING_REFUSAL = "Speed follows the person you're following.";

// Pure on the key: the proxy's loaded state flips while its manifest loads, and the proxy shifts pitch.
export function playbackSpeedAvailable(projectPath: string): boolean {
  return !(isShareProjectKey(projectPath) && !isFrozenReviewKey(projectPath));
}

// Why the speed cannot change now, else undefined; following wins because the leader's rate is theirs.
export function playbackSpeedRefusal(
  s: Pick<DawState, "followingClientId" | "projectPath">,
): string | undefined {
  if (s.followingClientId != null) {
    return FOLLOWING_REFUSAL;
  }
  return playbackSpeedAvailable(s.projectPath)
    ? undefined
    : SPEED_UNAVAILABLE_REASON;
}

// The speed Play, Pause, Stop and a finished scan return to.
export function effectiveChosen(
  s: Pick<DawState, "chosenPlaybackRate" | "projectPath">,
): number {
  return playbackSpeedAvailable(s.projectPath) ? s.chosenPlaybackRate : 1;
}
