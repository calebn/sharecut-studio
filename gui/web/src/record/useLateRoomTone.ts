import { useEffect, useState } from "react";
import type { RoomAlertInput } from "../system/roomAlertModel";
import {
  lateRoomToneDue,
  readRoomToneMark,
  roomToneMarkKey,
  writeRoomToneMark,
} from "./lateRoomTone";
import type { RoomToneStatus } from "./roomTone";
import {
  type RecordParticipant,
  type RecordSnapshot,
  ROOM_TONE_TOO_LOUD_COPY,
  ROOM_TONE_TOO_SHORT_COPY,
} from "./types";
import type { RecordUploadTransport } from "./upload/transport";

type RoomToneControls = {
  status: RoomToneStatus;
  error: string | null;
  captureReady: boolean;
  record: () => void;
  skip: () => void;
};

/**
 * A guest who joined after the room-tone countdown is asked once, before the
 * next take, to record the same one-minute bed through the same `useRoomToneCapture`
 * the host-started round uses. Done means recorded or skipped; both survive a reload (this device, or the host's upload
 * status for a recorded bed). While the take runs the alert slot shows the
 * capturing row (`roomToneCapturingAlert`), not this prompt.
 */
export function useLateRoomTone({
  snapshot,
  me,
  producer,
  transport,
  roomTone,
}: {
  snapshot: RecordSnapshot | null;
  me: RecordParticipant | undefined | null;
  producer: boolean;
  transport: RecordUploadTransport | null;
  roomTone: RoomToneControls;
}): RoomAlertInput | null {
  const participantId = me?.participant_id ?? null;
  const key = roomToneMarkKey(snapshot?.session_id, participantId);
  const consented = me?.consented === true;
  const [resolved, setResolved] = useState<{
    key: string;
    done: boolean;
  } | null>(null);
  const left = snapshot?.countdown_left_ms ?? 0;
  const [settled, setSettled] = useState<RecordSnapshot | null>(null);
  const { status } = roomTone;

  useEffect(() => {
    if (!key || !consented || producer) {
      return;
    }
    if (readRoomToneMark(key)) {
      setResolved({ key, done: true });
      return;
    }
    if (!transport) {
      return;
    }
    let live = true;
    transport
      .status()
      .then((remote) => {
        const done = (remote.room_tone_status ?? []).some(
          (row) =>
            row.participant_id === participantId &&
            row.file_ack &&
            !row.land_failed,
        );
        if (live) {
          setResolved({ key, done });
        }
      })
      .catch(() => {
        if (live) {
          setResolved({ key, done: false });
        }
      });
    return () => {
      live = false;
    };
  }, [consented, key, participantId, producer, transport]);

  useEffect(() => {
    if (!key) {
      return;
    }
    if (status === "skipped") {
      writeRoomToneMark(key, "skipped");
    } else if (status === "recorded") {
      writeRoomToneMark(key, "recorded");
    }
  }, [key, status]);

  useEffect(() => {
    if (!snapshot || left <= 0) {
      return;
    }
    const timer = setTimeout(() => setSettled(snapshot), left);
    return () => clearTimeout(timer);
  }, [left, snapshot]);

  const running = left > 0 && settled !== snapshot;
  if (
    producer ||
    status === "capturing" ||
    !lateRoomToneDue(snapshot, me) ||
    running ||
    !roomTone.captureReady ||
    status === "recorded" ||
    status === "skipped" ||
    resolved?.key !== key ||
    resolved.done
  ) {
    return null;
  }
  return {
    kind: "room-tone",
    message:
      status === "too_loud"
        ? ROOM_TONE_TOO_LOUD_COPY
        : status === "too_short"
          ? ROOM_TONE_TOO_SHORT_COPY
          : status === "error"
            ? (roomTone.error ?? undefined)
            : undefined,
    onAction: roomTone.record,
    onSecondaryAction: roomTone.skip,
  };
}
