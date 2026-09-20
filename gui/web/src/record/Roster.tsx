import { useEffect, useRef, useState } from "react";
import type { RecordParticipant } from "./types";

type Props = {
  participants: RecordParticipant[];
};

export function Roster({ participants }: Props) {
  const live = participants.filter((p) => p.connected && !p.removed);
  const recording = live.filter((p) => p.role !== "producer");
  const listeners = live.filter((p) => p.role === "producer");
  const liveKey = live.map((p) => p.participant_id).join(",");
  const prev = useRef<Set<string>>(new Set());
  const names = useRef<Map<string, string>>(new Map());
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const ids = new Set(liveKey ? liveKey.split(",") : []);
    for (const p of participants) {
      names.current.set(p.participant_id, p.display_name);
    }
    const seeded = prev.current.size > 0 || ids.size === 0;
    if (seeded) {
      for (const id of ids) {
        if (!prev.current.has(id)) {
          setAnnouncement(`${names.current.get(id) || "Someone"} joined`);
        }
      }
      for (const id of prev.current) {
        if (!ids.has(id)) {
          setAnnouncement(`${names.current.get(id) || "Someone"} left`);
        }
      }
    }
    prev.current = ids;
  }, [liveKey, participants]);

  return (
    <div className="stack">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <section aria-labelledby="rec-group">
        <h2 id="rec-group">Recording</h2>
        <ul className="record-roster">
          {recording.map((p) => (
            <li key={p.participant_id}>
              {p.display_name}
              {p.consented === true ? " · consented" : ""}
              {p.consented === false ? " · declined" : ""}
              {p.muted ? " · muted" : ""}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="listen-group">
        <h2 id="listen-group">Not recorded</h2>
        <ul className="record-roster">
          {listeners.map((p) => (
            <li key={p.participant_id}>{p.display_name}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
