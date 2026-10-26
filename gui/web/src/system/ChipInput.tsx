import {
  type ClipboardEvent,
  type KeyboardEvent,
  useId,
  useRef,
  useState,
} from "react";
import { Button, Field, StatusLiveRegion } from "../ui";
import { SystemIcon } from "./SystemIcon";

/**
 * Limits mirror the transcript context the backend builds
 * (transcript_context.py): 400 characters in all, less the 28 of
 * "Podcast episode transcript. ", so 372 for the ", "-joined speakers and
 * terms; at most 100 entries of at most 100 characters.
 */
const BUDGET = 372;
const MAX_ENTRIES = 100;
const MAX_ENTRY_CHARS = 100;
const WARN_AT = 40;
const LABEL = "Names and terms";
const LIMIT_TEXT = "That is the limit. Remove a term to add more.";

export type ChipInputProps = {
  /** Fixed chips first: the people in the room. They cannot be removed here. */
  speakers: readonly string[];
  terms: readonly string[];
  onTermsChange: (terms: string[]) => void;
  /** Characters already spent elsewhere, such as the show title. */
  reservedChars?: number;
};

function used(entries: readonly string[]): number {
  return entries.length === 0
    ? 0
    : entries.reduce((sum, entry) => sum + entry.length, 0) +
        (entries.length - 1) * 2;
}

type Note = { text: string; tone: "limit" | "duplicate" | "long" };

/**
 * Names and terms to listen for. Speakers lead, fixed; terms follow, each
 * removable. Enter or a comma adds, a paste with commas splits, and the
 * budget is shown only when it gets close.
 */
export function ChipInput({
  speakers,
  terms,
  onTermsChange,
  reservedChars = 0,
}: ChipInputProps) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const [live, setLive] = useState({ message: "", seq: 0 });
  const noteId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const budget = BUDGET - reservedChars;
  const all = [...speakers, ...terms];
  const left = budget - used(all);

  const announce = (message: string) =>
    setLive((current) => ({ message, seq: current.seq + 1 }));

  function add(raw: string): boolean {
    const parts = raw
      .split(/[,\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const nextTerms = [...terms];
    const before = left;
    let refused: Note | null = null;
    let added = false;
    for (const part of parts) {
      const current = [...speakers, ...nextTerms];
      const seen = current.some(
        (entry) => entry.toLowerCase() === part.toLowerCase(),
      );
      if (seen) {
        refused = { text: `${part} is already there.`, tone: "duplicate" };
        continue;
      }
      if (part.length > MAX_ENTRY_CHARS) {
        refused = {
          text: `Keep each term under ${MAX_ENTRY_CHARS} characters.`,
          tone: "long",
        };
        break;
      }
      const cost = (current.length > 0 ? 2 : 0) + part.length;
      if (current.length >= MAX_ENTRIES || cost > budget - used(current)) {
        refused = { text: LIMIT_TEXT, tone: "limit" };
        break;
      }
      nextTerms.push(part);
      added = true;
    }
    if (added) {
      onTermsChange(nextTerms);
      const after = budget - used([...speakers, ...nextTerms]);
      if (after <= 0 && before > 0) announce("No characters left");
      else if (after <= WARN_AT && before > WARN_AT)
        announce(`${after} characters left`);
    }
    setNote(refused);
    if (refused) {
      announce(refused.text);
    }
    return added;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Backspace") {
      const input = event.currentTarget;
      if (
        input.value === "" &&
        input.selectionStart === 0 &&
        terms.length > 0
      ) {
        onTermsChange(terms.slice(0, -1));
        setNote(null);
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== ",") return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (event.currentTarget.value.trim() === "") return;
    if (add(event.currentTarget.value)) {
      event.preventDefault();
      setText("");
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/[,\n]/.test(pasted)) return;
    event.preventDefault();
    add(pasted);
  }

  function remove(term: string) {
    onTermsChange(terms.filter((entry) => entry !== term));
    setNote(null);
    inputRef.current?.focus();
  }

  const seenSpeakers = new Map<string, number>();
  return (
    <div className="sys-chipinput">
      <Field label={LABEL} hint="Press Enter or a comma to add.">
        {(control) => (
          <div className="sys-chips">
            <ul className="sys-chips-list" aria-label={`${LABEL} added`}>
              {speakers.map((speaker) => {
                const nth = (seenSpeakers.get(speaker) ?? 0) + 1;
                seenSpeakers.set(speaker, nth);
                return (
                  <li
                    key={`speaker-${speaker}-${nth}`}
                    className="sys-chip sys-chip--speaker"
                    aria-label={`${speaker}, speaker`}
                  >
                    <SystemIcon name="user" size={14} />
                    <span>{speaker}</span>
                  </li>
                );
              })}
              {terms.map((term) => (
                <li key={`term-${term.toLowerCase()}`} className="sys-chip">
                  <span>{term}</span>
                  <Button
                    className="ui-control--quiet sys-chip-remove"
                    aria-label={`Remove ${term}`}
                    onClick={() => remove(term)}
                  >
                    <SystemIcon name="x" size={12} />
                  </Button>
                </li>
              ))}
            </ul>
            <input
              {...control}
              ref={inputRef}
              type="text"
              autoComplete="off"
              className="sys-chips-input"
              value={text}
              aria-describedby={[control["aria-describedby"], noteId]
                .filter(Boolean)
                .join(" ")}
              onChange={(event) => {
                setText(event.target.value);
                setNote(null);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          </div>
        )}
      </Field>
      <p id={noteId} className="sys-chips-meta">
        {note ? <span className="sys-chips-note">{note.text}</span> : null}
        {left <= WARN_AT ? (
          <span className="sys-chips-count">{`${Math.max(left, 0)} left`}</span>
        ) : null}
      </p>
      <StatusLiveRegion message={live.message} seq={live.seq} />
    </div>
  );
}
