import { useMemo, useState } from "react";
import { lookingInCount, lookingInLine } from "../system/roomViewModel";
import { MARKER_BODY } from "./liveCommentQueue";
import type { RecordParticipant, RecordSnapshot } from "./types";

function liveIds(participants: readonly RecordParticipant[], meId: string) {
  return new Set(
    participants
      .filter((p) => p.connected && !p.removed && p.participant_id !== meId)
      .map((p) => p.participant_id),
  );
}

type LookingInWatch = {
  watchers: number | null;
  /** The room the count was last read in. */
  room: string | null;
  /** The room whose first looking-in arrival was already announced. */
  announcedRoom: string | null;
};

const NO_LOOKING_IN: LookingInWatch = {
  watchers: null,
  room: null,
  announcedRoom: null,
};

/** A room-tone round is counting down: the room is quiet on purpose. */
const countingDown = (snapshot: RecordSnapshot) =>
  Boolean(snapshot.room_tone) && (snapshot.countdown_left_ms ?? 0) > 0;

/**
 * The one polite line for people looking in: the first rise from none to some
 * in a room, seen while it is waiting or stopped, never during a take or the
 * room-tone countdown. A rise that lands in a countdown is held and spoken
 * once the countdown ends in the lobby. A room this page has not seen before
 * starts from none, so its first arrival is spoken even if the last room ended
 * with someone looking in.
 */
function watchLookingIn(
  before: LookingInWatch,
  snapshot: RecordSnapshot,
): { watch: LookingInWatch; line: string | null } {
  if (countingDown(snapshot)) return { watch: before, line: null };
  const watchers = lookingInCount(snapshot.watchers);
  const room = snapshot.session_id;
  const known =
    before.room !== null && before.room !== room
      ? { ...before, watchers: 0 }
      : before;
  const rose =
    known.watchers === 0 &&
    watchers > 0 &&
    known.announcedRoom !== room &&
    (snapshot.state === "lobby" || snapshot.state === "stopped");
  if (rose) {
    return {
      watch: { watchers, room, announcedRoom: room },
      line: lookingInLine(watchers),
    };
  }
  return known.watchers === watchers && known.room === room
    ? { watch: known, line: null }
    : { watch: { ...known, watchers, room }, line: null };
}

type RosterObservation = {
  people: ReadonlySet<string> | null;
  names: ReadonlyMap<string, string>;
  comments: ReadonlySet<string> | null;
  lookingIn: LookingInWatch;
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
  const looking = watchLookingIn(before.lookingIn, snapshot);
  if (looking.line) lines.push(looking.line);
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
    before.lookingIn === looking.watch &&
    comments.size === before.comments.size &&
    [...comments].every((id) => before.comments?.has(id))
  ) {
    return before;
  }
  return {
    people,
    names,
    comments,
    lookingIn: looking.watch,
    announcement: lines.length ? lines.join(". ") : before.announcement,
  };
}

/**
 * The one polite line a screen reader hears from the room: who joined or left,
 * and what someone else just wrote. What is already there on first render, and
 * your own comments, stay silent. Render the text in a `PoliteAnnouncer`.
 */
export function useRosterAnnouncer(
  snapshot: RecordSnapshot | null,
  meId: string | null,
): string {
  const [observation, setObservation] = useState<RosterObservation>(() => ({
    people: null,
    names: new Map(),
    comments: null,
    lookingIn: NO_LOOKING_IN,
    announcement: "",
  }));
  const next = useMemo(
    () => observeRoster(observation, snapshot, meId),
    [observation, snapshot, meId],
  );
  if (next !== observation) setObservation(next);
  return observation.announcement;
}

/**
 * The host page's one polite line, for people looking in only: the host sees
 * the people and the comments, so nothing else is read out.
 */
export function useLookingInAnnouncer(snapshot: RecordSnapshot | null): {
  text: string;
  /** Counts each spoken line, so the page can render a new note for each one. */
  seq: number;
} {
  const [seen, setSeen] = useState({
    watch: NO_LOOKING_IN,
    announcement: "",
    seq: 0,
  });
  if (snapshot) {
    const looking = watchLookingIn(seen.watch, snapshot);
    if (looking.watch !== seen.watch || looking.line) {
      // The note goes with the people: it stays only while someone is looking in.
      const stays =
        looking.watch.watchers !== 0 && looking.watch.room === seen.watch.room;
      setSeen({
        watch: looking.watch,
        announcement: looking.line ?? (stays ? seen.announcement : ""),
        seq: looking.line ? seen.seq + 1 : seen.seq,
      });
    }
  }
  return { text: seen.announcement, seq: seen.seq };
}
