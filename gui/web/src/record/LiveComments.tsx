import { useId } from "react";
import { Button, Field } from "../ui";
import { plural } from "../utils/format";
import { type LiveComment, liveTakeOpen } from "./liveCommentQueue";
import type { RecordParticipant, RecordSnapshot } from "./types";

type Props = {
  snapshot: RecordSnapshot;
  comments?: LiveComment[];
  note: string;
  onNote: (value: string) => void;
  onMarker: () => void;
  onSubmitNote: () => void;
};

function authorLabel(
  snapshot: RecordSnapshot,
  author: string,
  me: RecordParticipant | null | undefined,
): string {
  if (me && author === me.participant_id) {
    return "You";
  }
  const person = snapshot.participants.find(
    (row) => row.participant_id === author,
  );
  return person?.display_name || author;
}

export function LiveComments({
  snapshot,
  comments = snapshot.comments ?? [],
  note,
  onNote,
  onMarker,
  onSubmitNote,
  me,
}: Props & { me?: RecordParticipant | null }) {
  const open = liveTakeOpen(snapshot.state);
  const headingId = useId();
  const noteId = useId();
  const listId = useId();
  return (
    <section className="stack record-live-comments" aria-labelledby={headingId}>
      <h2 id={headingId}>Live comments</h2>
      <div aria-live="polite" className="sr-only" id={listId}>
        {comments.length > 0
          ? `${comments.length} live ${plural(comments.length, "comment")}`
          : "No live comments yet."}
      </div>
      {comments.length > 0 ? (
        <ul className="record-roster">
          {comments.map((row) => (
            <li key={row.id}>
              {authorLabel(snapshot, row.author, me)}: {row.body}
            </li>
          ))}
        </ul>
      ) : (
        <p>No live comments yet.</p>
      )}
      <div className="cluster">
        <Button type="button" onClick={onMarker} disabled={!open}>
          Marker
        </Button>
      </div>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitNote();
        }}
      >
        <Field label="Note" htmlFor={noteId}>
          <input
            id={noteId}
            value={note}
            onChange={(event) => onNote(event.target.value)}
            disabled={!open}
          />
        </Field>
        <Button type="submit" disabled={!open || !note.trim()}>
          Add note
        </Button>
      </form>
    </section>
  );
}
