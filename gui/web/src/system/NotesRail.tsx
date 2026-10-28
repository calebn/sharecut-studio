import { type KeyboardEvent, useId, useRef } from "react";
import { ToggleButton } from "../ui";
import {
  canSendNote,
  isRestrictedNote,
  type NoteDraft,
  type NoteItem,
  type NoteViewer,
  noteSnippet,
  sortNotes,
  visibleNotes,
} from "./notesRailModel";
import { QueueRow } from "./QueueRow";
import { SystemIcon } from "./SystemIcon";
import { iconOf } from "./verbDisplay";

export type NotesRailProps = {
  items: NoteItem[];
  /** Who is looking: a guest sees only what `visibleNotes` lets through. */
  viewer: NoteViewer;
  /** The viewer's own name, so a guest keeps their own notes. */
  selfName: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  /** The pinned time chip, or null for a session-level note. */
  draftTime: string | null;
  onClearTime: () => void;
  everyone: boolean;
  /** Only host and producers can widen a note, so only they get the toggle. */
  onEveryoneChange?: (everyone: boolean) => void;
  onSend: (note: NoteDraft) => void;
  /** The composer still works while paused; the line says the notes land at the pause. */
  paused?: boolean;
  onSelect?: (id: string) => void;
  /** Why notes cannot be sent now. The composer is disabled and the line shows the reason. */
  disabledReason?: string;
};

const SEND_REASON = "Write a note to send";
const IME_KEYCODE = 229;

/**
 * The Notes rail body: the chronological list of markers and notes as
 * QueueRow comment rows, then one composer. Presentational: the caller owns
 * the draft, the pinned time and the list.
 */
export function NotesRail({
  items,
  viewer,
  selfName,
  draft,
  onDraftChange,
  draftTime,
  onClearTime,
  everyone,
  onEveryoneChange,
  onSend,
  paused = false,
  onSelect,
  disabledReason,
}: NotesRailProps) {
  const fieldId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const reasonId = useId();
  const rows = sortNotes(visibleNotes(items, viewer, selfName));
  const canSend = canSendNote(draft) && !disabledReason;
  const reason = disabledReason ?? SEND_REASON;
  const send = () => {
    if (!canSend) return;
    onSend({ text: draft.trim(), time: draftTime, everyone });
  };
  // Enter sends. Shift+Enter keeps its newline, and an IME commit is not a send.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // keyCode 229 is the IME's own keydown, which some browsers send without isComposing.
    const composing =
      event.nativeEvent.isComposing || event.keyCode === IME_KEYCODE;
    if (event.key !== "Enter" || event.shiftKey || composing) return;
    event.preventDefault();
    send();
  };
  return (
    <section className="sys-notes" aria-label="Notes">
      <div className="sys-notes-history">
        {rows.length === 0 ? (
          <p className="sys-notes-quiet">
            No notes yet. Notes pin to the recording time.
          </p>
        ) : (
          <ul className="sys-notes-list">
            {rows.map((item) => (
              <li key={item.id}>
                <QueueRow
                  kind="comment"
                  author={item.author}
                  snippet={
                    item.kind === "marker" ? (
                      <>
                        <SystemIcon
                          name={iconOf("comment")}
                          size={14}
                          className="sys-notes-pin"
                        />
                        {noteSnippet(item)}
                      </>
                    ) : (
                      <span title={noteSnippet(item)}>{noteSnippet(item)}</span>
                    )
                  }
                  time={item.time ?? undefined}
                  restricted={isRestrictedNote(item)}
                  onSelect={onSelect ? () => onSelect(item.id) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
        {paused ? (
          <p className="sys-notes-quiet">Paused. Notes land at the pause.</p>
        ) : null}
      </div>
      <div className="sys-notes-composer">
        <label className="sr-only" htmlFor={fieldId}>
          Add a note
        </label>
        <div className="sys-notes-field">
          {draftTime !== null ? (
            <button
              type="button"
              className="sys-notes-time"
              aria-label={`${draftTime}, clear time to make this a session note`}
              onClick={() => {
                onClearTime();
                // The chip unmounts with the time, so the focus moves to the field.
                input.current?.focus();
              }}
            >
              <span className="sys-mono">{draftTime}</span>
              <SystemIcon name="x" size={12} />
            </button>
          ) : null}
          <textarea
            id={fieldId}
            ref={input}
            className="sys-notes-input"
            rows={1}
            placeholder="Add a note"
            value={draft}
            disabled={disabledReason !== undefined}
            aria-describedby={canSend ? undefined : reasonId}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="sys-notes-send"
            aria-label="Send note"
            aria-disabled={canSend ? undefined : true}
            title={canSend ? "Send note" : reason}
            aria-describedby={canSend ? undefined : reasonId}
            onClick={send}
          >
            <SystemIcon name="send" size={16} />
          </button>
        </div>
        {!canSend ? (
          <p id={reasonId} className="sys-notes-quiet">
            {reason}
          </p>
        ) : null}
        {onEveryoneChange ? (
          <ToggleButton
            quiet
            className="sys-notes-everyone"
            pressed={everyone}
            title="On: everyone in the room sees this note. Off: host and producers only."
            onClick={() => onEveryoneChange(!everyone)}
          >
            Everyone
          </ToggleButton>
        ) : null}
      </div>
    </section>
  );
}
