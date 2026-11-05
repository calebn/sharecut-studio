import { useState } from "react";
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
  const [observation, setObservation] = useState<{
    status: RoomToneStatus;
    line: { text: string; seq: number } | null;
  }>(() => ({ status, line: null }));
  if (observation.status !== status) {
    const text =
      status === "capturing"
        ? ROOM_TONE_START_ANNOUNCEMENT
        : observation.status === "capturing"
          ? END_ANNOUNCEMENT[status]
          : undefined;
    setObservation({
      status,
      line: text
        ? { text, seq: (observation.line?.seq ?? 0) + 1 }
        : observation.line,
    });
  }
  return observation.line;
}
