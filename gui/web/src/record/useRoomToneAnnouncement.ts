import { useEffect, useRef, useState } from "react";
import type { RoomToneStatus } from "./roomTone";
import { ROOM_TONE_TOO_LOUD_COPY, ROOM_TONE_TOO_SHORT_COPY } from "./types";

export const ROOM_TONE_START_ANNOUNCEMENT =
  "Recording room tone, one minute, stay quiet";

const END_ANNOUNCEMENT: Partial<Record<RoomToneStatus, string>> = {
  recorded: "Room tone recorded",
  idle: "Room tone cancelled",
  skipped: "Room tone cancelled",
  too_short: ROOM_TONE_TOO_SHORT_COPY,
  too_loud: ROOM_TONE_TOO_LOUD_COPY,
  error: "Room tone failed",
};

/**
 * The one polite line when a room-tone take starts and the one when it ends,
 * is cancelled or comes out too short. The ticking countdown is never live.
 */
export function useRoomToneAnnouncement(
  status: RoomToneStatus,
): { text: string; seq: number } | null {
  const [line, setLine] = useState<{ text: string; seq: number } | null>(null);
  const before = useRef<RoomToneStatus>(status);
  useEffect(() => {
    const was = before.current;
    before.current = status;
    if (status === was) {
      return;
    }
    if (status === "capturing") {
      setLine((now) => ({
        text: ROOM_TONE_START_ANNOUNCEMENT,
        seq: (now?.seq ?? 0) + 1,
      }));
    } else if (was === "capturing") {
      const text = END_ANNOUNCEMENT[status];
      if (text) {
        setLine((now) => ({ text, seq: (now?.seq ?? 0) + 1 }));
      }
    }
  }, [status]);
  return line;
}
