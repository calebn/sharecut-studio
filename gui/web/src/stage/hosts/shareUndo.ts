import type { RestoreRefusalCode } from "../../api";

/** What the toast says about one ended link or room, and what Undo brings back. */
export type UndoCopy = {
  ended: string;
  restored: string;
};

export const LINK_UNDO: UndoCopy = {
  ended: "Link stopped.",
  restored: "Link restored.",
};

export const ROOM_UNDO: UndoCopy = {
  ended: "Room ended.",
  restored: "Room restored.",
};

/** The toast leaves this much before the server stops honoring Undo. */
const UNDO_MARGIN_MS = 500;

/** How long the toast stays up for the window the server gave, or null when there is no time left to offer Undo. */
export function undoDwellMs(restoreMs: number | null): number | null {
  if (restoreMs === null) return null;
  const dwell = restoreMs - UNDO_MARGIN_MS;
  return dwell > 0 ? dwell : null;
}

/** Why Undo was refused, in the words of the thing that stayed ended. */
export function refusalCopy(
  code: RestoreRefusalCode,
  what: "link" | "room",
): string {
  switch (code) {
    case "restore_window_closed":
      return "Too late to undo.";
    case "share_expired":
      return "This link had already expired, so it stays stopped.";
    case "record_room_conflict":
      return "Another room is live, so this one stays ended.";
    case "share_not_found":
    case "record_room_not_found":
      return `That ${what} is already gone, so there is nothing to undo.`;
  }
}
