import { readLocal, writeLocal } from "../utils/storage";
import type { RecordParticipant, RecordSnapshot } from "./types";

export type RoomToneMark = "recorded" | "skipped";

export function lateRoomToneDue(
  snapshot: RecordSnapshot | null,
  me: RecordParticipant | undefined | null,
): boolean {
  if (!snapshot || !me || me.consented !== true) {
    return false;
  }
  if (snapshot.state !== "lobby" && snapshot.state !== "stopped") {
    return false;
  }
  const round = snapshot.room_tone;
  return !!round && !round.participant_ids.includes(me.participant_id);
}

export function roomToneMarkKey(
  sessionId: string | null | undefined,
  participantId: string | null | undefined,
): string | null {
  return sessionId && participantId
    ? `sharecut.room-tone.${sessionId}.${participantId}`
    : null;
}

export function readRoomToneMark(key: string): RoomToneMark | null {
  const value = readLocal(key);
  return value === "recorded" || value === "skipped" ? value : null;
}

export function writeRoomToneMark(key: string, mark: RoomToneMark): void {
  writeLocal(key, mark);
}
