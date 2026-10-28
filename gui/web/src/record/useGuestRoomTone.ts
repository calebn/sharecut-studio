import { useEffect, useRef } from "react";
import type { RecordSnapshot } from "./types";

type RoomToneControls = {
  captureReady: boolean;
  record: () => void;
};

/**
 * A guest records room tone only when the host starts a round that names them.
 * The round already in the first snapshot (a reload or a late join) is left
 * alone: its quiet window is gone. Capture and upload are the same path the
 * old lobby used, through `useRoomToneCapture`.
 */
export function useGuestRoomTone({
  snapshot,
  participantId,
  consented,
  roomTone,
}: {
  snapshot: RecordSnapshot | null;
  participantId: string | null;
  consented: boolean | null;
  roomTone: RoomToneControls;
}): void {
  const handled = useRef<number | null | undefined>(undefined);
  const round = snapshot?.room_tone?.round ?? null;
  const named =
    participantId !== null &&
    (snapshot?.room_tone?.participant_ids.includes(participantId) ?? false);
  const { captureReady, record } = roomTone;

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    if (handled.current === undefined) {
      handled.current = round;
      return;
    }
    if (round === null || round === handled.current) {
      return;
    }
    handled.current = round;
    if (named && consented === true && captureReady) {
      record();
    }
  }, [snapshot, round, named, consented, captureReady, record]);
}
