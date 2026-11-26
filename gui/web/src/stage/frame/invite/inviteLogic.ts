import {
  type RecordRoomGroup,
  reachOf,
  type ShareChoices,
  type ShareOptions,
} from "../../../stages/deliver/shareLogic";
import type { TunnelStatus } from "../../../types/tunnel";
import { BUSY_REASON } from "../../../ui/disabledReason";

export const LOOKING_REASON = "Looking for your links…";
export const SET_AT_MAKING =
  "Set when the link is made. Stop sharing and make a new one to change it.";

/** Why Copy waits: an action runs, the list has not answered, or sharing is unavailable. */
export function copyReasonOf(options: ShareOptions): string | undefined {
  if (options.busy) return BUSY_REASON;
  if (options.blockedReason) return options.blockedReason;
  if (!options.loaded && !options.listFailed) return LOOKING_REASON;
  return undefined;
}

/** Whether the create that needs Refresh mix came from this row: the listen link, or a review link with these choices. */
export function needsMixFor(
  options: ShareOptions,
  row: { listen: true } | { listen: false; choices: ShareChoices },
): boolean {
  const { recovery, refreshFor } = options;
  if (recovery.kind !== "needs_refresh" || !refreshFor) return false;
  if (row.listen) return refreshFor.listen;
  const a = refreshFor.choices;
  return (
    !refreshFor.listen &&
    a.role === row.choices.role &&
    a.withMcp === row.choices.withMcp &&
    a.freeze === row.choices.freeze
  );
}

/** Whether a guest or producer link the host can still copy is only reachable on this network. */
export function roomIsLocalOnly(
  room: RecordRoomGroup,
  tunnel: TunnelStatus | null | undefined,
): boolean {
  return [...room.guests, ...room.producers].some(
    (row) =>
      row.url !== null &&
      row.url !== undefined &&
      !row.invite_closed &&
      reachOf(tunnel, row.url) === "network",
  );
}

/** Why the room's links stop at this network: sharing was turned off, or was never set up. */
export function localOnlyNoteOf(tunnel: TunnelStatus | null | undefined) {
  return tunnel?.state === "off"
    ? "Online sharing is off, so only people on this network can open these links."
    : "Online sharing isn't set up on this computer, so only people on this network can open these links.";
}
