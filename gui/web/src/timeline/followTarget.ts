import type { DawState } from "../state/types";

/** The session client this viewer follows, if any. */
export function followTarget(s: DawState) {
  return s.followingClientId
    ? s.sessionClients.find((c) => c.client_id === s.followingClientId)
    : undefined;
}

/** Colour index of the followed client, for the timeline's presence tint. */
export function selectFollowColorIndex(s: DawState): number | undefined {
  return followTarget(s)?.meta?.color_index;
}
