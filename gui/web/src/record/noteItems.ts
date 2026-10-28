import type { NoteItem } from "../system/notesRailModel";
import { clockText } from "../system/roomPhase";
import { MARKER_BODY } from "./liveCommentQueue";
import type { RecordSnapshot } from "./types";

export function noteItems(snapshot: RecordSnapshot | null): NoteItem[] {
  if (!snapshot) {
    return [];
  }
  const byId = new Map(
    snapshot.participants.map((person, index) => [
      person.participant_id,
      { name: person.display_name, colorIndex: index },
    ]),
  );
  return (snapshot.comments ?? []).map((comment) => {
    const marker = comment.body === MARKER_BODY;
    const item: NoteItem = {
      id: comment.id,
      kind: marker ? "marker" : "note",
      author: byId.get(comment.author) ?? { name: comment.author },
      time: clockText(comment.recording_ms / 1000),
    };
    if (!marker) {
      item.text = comment.body;
      item.visibility = "everyone";
    }
    return item;
  });
}
