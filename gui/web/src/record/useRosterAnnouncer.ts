import { useMemo, useState } from "react";
import { MARKER_BODY } from "./liveCommentQueue";
import type { RecordParticipant, RecordSnapshot } from "./types";

function liveIds(participants: readonly RecordParticipant[], meId: string) {
  return new Set(
    participants
      .filter((p) => p.connected && !p.removed && p.participant_id !== meId)
      .map((p) => p.participant_id),
  );
}

type RosterObservation = {
  people: ReadonlySet<string> | null;
  names: ReadonlyMap<string, string>;
  comments: ReadonlySet<string> | null;
  announcement: string;
};

function sameOrder(before: ReadonlySet<string>, now: ReadonlySet<string>) {
  if (before.size !== now.size) return false;
  const current = now.values();
  for (const id of before) {
    if (id !== current.next().value) return false;
  }
  return true;
}

function observeRoster(
  before: RosterObservation,
  snapshot: RecordSnapshot | null,
  meId: string | null,
): RosterObservation {
  if (!snapshot || !meId) return before;
  const names = new Map(before.names);
  for (const person of snapshot.participants) {
    names.set(person.participant_id, person.display_name);
  }
  const nameOf = (id: string) => names.get(id) || "Someone";
  const people = liveIds(snapshot.participants, meId);
  const lines: string[] = [];
  if (before.people) {
    for (const id of people) {
      if (!before.people.has(id)) lines.push(`${nameOf(id)} joined`);
    }
    for (const id of before.people) {
      if (!people.has(id)) lines.push(`${nameOf(id)} left`);
    }
  }
  const rows = snapshot.comments ?? [];
  const comments = new Set(rows.map((row) => row.id));
  if (before.comments) {
    for (const row of rows) {
      if (!before.comments.has(row.id) && row.author !== meId) {
        lines.push(
          row.body === MARKER_BODY
            ? `${nameOf(row.author)} added a marker`
            : `${nameOf(row.author)}: ${row.body}`,
        );
      }
    }
  }
  if (
    before.people !== null &&
    sameOrder(before.people, people) &&
    names.size === before.names.size &&
    [...names].every(([id, name]) => before.names.get(id) === name) &&
    before.comments !== null &&
    comments.size === before.comments.size &&
    [...comments].every((id) => before.comments?.has(id))
  ) {
    return before;
  }
  return {
    people,
    names,
    comments,
    announcement: lines.length ? lines.join(". ") : before.announcement,
  };
}

/**
 * The one polite line a screen reader hears from the room: who joined or left,
 * and what someone else just wrote. What is already there on first render, and
 * your own notes, stay silent. Render the text in a `PoliteAnnouncer`.
 */
export function useRosterAnnouncer(
  snapshot: RecordSnapshot | null,
  meId: string | null,
): string {
  const [observation, setObservation] = useState<RosterObservation>(() => ({
    people: null,
    names: new Map(),
    comments: null,
    announcement: "",
  }));
  const next = useMemo(
    () => observeRoster(observation, snapshot, meId),
    [observation, snapshot, meId],
  );
  if (next !== observation) setObservation(next);
  return observation.announcement;
}
