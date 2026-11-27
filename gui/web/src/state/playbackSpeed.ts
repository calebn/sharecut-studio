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

// A leader's rate as a follower plays it. The live-episode path pitch-shifts, so a leader's chosen 1.25x or 1.5x stays at 1x there; scan rates (2x, 4x) still follow, as they did before speed was chosen.
export function followerBaseRate(rate: number, projectPath: string): number {
  const base = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return !playbackSpeedAvailable(projectPath) && base < 2 ? 1 : base;
}

// A same-path refresh can flip the frozen-review status (the bootstrap sets it), which changes what the chosen speed is. When availability flipped since the last hydrate, re-apply the chosen speed unless a leader or a scan (playing at 2x or more) owns the rate.
export function sameProjectRatePatch(
  s: Pick<
    DawState,
    "followingClientId" | "isPlaying" | "playbackRate" | "chosenPlaybackRate"
  >,
  projectPath: string,
  wasAvailable: boolean | null,
): Partial<Pick<DawState, "playbackRate">> {
  if (
    wasAvailable === null ||
    wasAvailable === playbackSpeedAvailable(projectPath)
  ) {
    return {};
  }
  if (s.followingClientId != null) return {};
  if (s.isPlaying && s.playbackRate >= 2) return {};
  return {
    playbackRate: effectiveChosen({
      chosenPlaybackRate: s.chosenPlaybackRate,
      projectPath,
    }),
  };
}
