import type { RoomSaving } from "../system/roomTileModel";
import type { RoomPerson } from "../system/roomViewModel";
import type { RecordParticipant, RecordSnapshot } from "./types";

export const HOST_PARTICIPANT_ID = "p_host";

type RoomPeopleOptions = {
  youId?: string;
  youLevel?: number;
  youSpeaking?: boolean;
  dropped?: boolean;
  clipped?: number;
  saving?: Record<string, RoomSaving | null | undefined>;
};

function presenceOf(person: RecordParticipant, you: boolean) {
  if (you) {
    return "live" as const;
  }
  if (person.consented === false) {
    return "declined" as const;
  }
  if (!person.connected) {
    return "left" as const;
  }
  if (person.consented === null && person.role !== "producer") {
    return "joining" as const;
  }
  return "live" as const;
}

export function roomPeople(
  snapshot: RecordSnapshot | null,
  options: RoomPeopleOptions = {},
): RoomPerson[] {
  if (!snapshot) {
    return [];
  }
  const youId = options.youId ?? HOST_PARTICIPANT_ID;
  const people: RoomPerson[] = [];
  snapshot.participants.forEach((participant, index) => {
    if (participant.removed) {
      return;
    }
    const you = participant.participant_id === youId;
    const entry: RoomPerson = {
      role: participant.role,
      person: { name: participant.display_name, colorIndex: index },
      presence: presenceOf(participant, you),
      muted: participant.muted,
      saving: options.saving?.[participant.participant_id] ?? null,
    };
    if (you) {
      entry.you = true;
      entry.level = options.youLevel;
      entry.speaking = options.youSpeaking;
      entry.connection = options.dropped ? "lost" : "good";
      entry.clipped = options.clipped;
    }
    people.push(entry);
  });
  return people;
}
