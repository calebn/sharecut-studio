import { useEffect, useRef, useState } from "react";
import { MARKER_BODY } from "./liveCommentQueue";
import type { RecordParticipant, RecordSnapshot } from "./types";

function liveIds(participants: readonly RecordParticipant[], meId: string) {
  return new Set(
    participants
      .filter((p) => p.connected && !p.removed && p.participant_id !== meId)
      .map((p) => p.participant_id),
  );
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
  const [announcement, setAnnouncement] = useState("");
  const people = useRef<Set<string> | null>(null);
  const names = useRef<Map<string, string>>(new Map());
  const comments = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!snapshot || !meId) {
      return;
    }
    for (const p of snapshot.participants) {
      names.current.set(p.participant_id, p.display_name);
    }
    const nameOf = (id: string) => names.current.get(id) || "Someone";
    const lines: string[] = [];

    const now = liveIds(snapshot.participants, meId);
    const before = people.current;
    people.current = now;
    if (before) {
      for (const id of now) {
        if (!before.has(id)) lines.push(`${nameOf(id)} joined`);
      }
      for (const id of before) {
        if (!now.has(id)) lines.push(`${nameOf(id)} left`);
      }
    }

    const all = snapshot.comments ?? [];
    const known = comments.current;
    comments.current = new Set(all.map((row) => row.id));
    if (known) {
      for (const row of all) {
        if (!known.has(row.id) && row.author !== meId) {
          lines.push(
            row.body === MARKER_BODY
              ? `${nameOf(row.author)} added a marker`
              : `${nameOf(row.author)}: ${row.body}`,
          );
        }
      }
    }
    if (lines.length > 0) {
      setAnnouncement(lines.join(". "));
    }
  }, [snapshot, meId]);

  return announcement;
}
