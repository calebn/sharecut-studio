import { createHostRecordRoom } from "../api";
import type { HostShareRow, MintedRecordRoom } from "../types/shares";
import { errorMessage } from "../utils/apiError";

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
}

/** The room's guest link a host can still send, or null once it is revoked or closed. */
export function activeGuestLink(
  rows: readonly HostShareRow[],
  sessionId: string,
): string | null {
  const row = rows.find(
    (share) =>
      share.kind === "record" &&
      share.record_role === "guest" &&
      share.session_id === sessionId &&
      share.usable &&
      !share.revoked &&
      !share.invite_closed &&
      share.url,
  );
  return row?.url ?? null;
}

/** What to tell a host whose new room is ready but earlier rooms' links may still work. */
export const STALE_ROOM_LINKS_WARNING =
  "Your new room is ready. Links to an earlier room may still work. End the earlier room in Share to turn them off.";

export type CreatedRecordRoom = {
  room: MintedRecordRoom;
  copied: boolean;
  /** Why a guest link that exists could not be copied. */
  copyError: string | null;
};

/** Create a record room and copy its guest link, the step a host takes next. */
export async function createRecordRoomAndCopyGuestLink(
  projectPath: string,
): Promise<CreatedRecordRoom> {
  const room = await createHostRecordRoom(projectPath);
  if (!room.guest.url) {
    return { room, copied: false, copyError: null };
  }
  try {
    await copyText(room.guest.url);
    return { room, copied: true, copyError: null };
  } catch (err) {
    return { room, copied: false, copyError: errorMessage(err) };
  }
}
