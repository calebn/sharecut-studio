import type { NoteItem } from "../system/notesRailModel";
import { clockText } from "../system/roomPhase";
import { MARKER_BODY } from "./liveCommentQueue";
import type { RecordSnapshot } from "./types";

/** `selfId` is the viewer's participant id; with it each row says whether it is theirs. */
export function noteItems(
  snapshot: RecordSnapshot | null,
  selfId?: string,
): NoteItem[] {
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
    if (selfId !== undefined) {
      item.mine = comment.author === selfId;
    }
    if (!marker) {
      item.text = comment.body;
      item.visibility = "everyone";
    }
    return item;
  });
}
