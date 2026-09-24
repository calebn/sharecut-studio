import { useEffect, useRef, useState } from "react";
import {
  loadTranscriptVocabulary,
  saveTranscriptVocabulary,
  type TranscriptVocabulary,
} from "../api";
import { Button, Field, InlineError } from "../ui";
import { ApiError, errorMessage } from "../utils/apiError";

type VocabularyField = "terms" | "guest_names";

/** Mirrors VOCABULARY_MAX_ENTRIES in services/transcript_precorrect.py. */
export const VOCABULARY_MAX_ENTRIES = 100;
/**
 * Mirrors VOCABULARY_MAX_ENTRY_CHARS in services/transcript_precorrect.py.
 * The browser counts UTF-16 code units (`maxLength`, `.length`) and Python counts
 * code points, so entries with astral characters hit the UI cap first. The UI is
 * only stricter, never looser.
 */
export const VOCABULARY_MAX_ENTRY_CHARS = 100;

export const VOCABULARY_CONFLICT_MESSAGE =
  "Vocabulary changed in another window. The latest saved list is shown; add your changes again and save.";

const FIELD_COPY: Record<
  VocabularyField,
  { label: string; noun: string; list: string }
> = {
  terms: { label: "Terms", noun: "term", list: "Saved terms" },
  guest_names: {
    label: "Guest names",
    noun: "guest name",
    list: "Saved guest names",
  },
};

function sameEntries(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function vocabularyChanged(
  left: TranscriptVocabulary,
  right: TranscriptVocabulary,
): boolean {
  return (
    !sameEntries(left.terms, right.terms) ||
    !sameEntries(left.guest_names, right.guest_names)
  );
}

export function TranscriptVocabularyEditor({
  projectPath,
  busy,
  onRetranscribe,
  refreshKey,
}: {
  projectPath: string;
  busy: boolean;
  onRetranscribe: () => void;
  refreshKey: string;
}) {
  const [saved, setSaved] = useState<TranscriptVocabulary | null>(null);
  const [draft, setDraft] = useState<TranscriptVocabulary | null>(null);
  const savedRef = useRef<TranscriptVocabulary | null>(null);
  const requestSeq = useRef(0);
  const replaceDraftOnLoad = useRef(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [input, setInput] = useState<Record<VocabularyField, string>>({
    terms: "",
    guest_names: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // refreshKey (terminal pipeline job) and reloadTick (retry or post-failure
  // reload) only trigger this load; the body does not read them.
  useEffect(() => {
    let active = true;
    const seq = ++requestSeq.current;
    void loadTranscriptVocabulary(projectPath)
      .then((value) => {
        if (!active || seq !== requestSeq.current) return;
        const previous = savedRef.current;
        const replace = replaceDraftOnLoad.current;
        replaceDraftOnLoad.current = false;
        setDraft((current) =>
          !replace &&
          current &&
          previous &&
          vocabularyChanged(current, previous)
            ? current
            : value,
        );
        savedRef.current = value;
        setSaved(value);
        if (previous === null) setError(null);
      })
      .catch((reason) => {
        if (!active || seq !== requestSeq.current) return;
        // A failed reload must not leave a pending 409 replace armed for a later load.
        replaceDraftOnLoad.current = false;
        setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [projectPath, refreshKey, reloadTick]);

  const reload = () => setReloadTick((tick) => tick + 1);

  const add = (field: VocabularyField) => {
    const value = input[field].trim();
    if (!value || value.length > VOCABULARY_MAX_ENTRY_CHARS || !draft) return;
    if (draft[field].includes(value)) {
      setAnnouncement(`${value} is already in the list.`);
      return;
    }
    if (draft[field].length >= VOCABULARY_MAX_ENTRIES) {
      setAnnouncement(
        `${FIELD_COPY[field].label} allow up to ${VOCABULARY_MAX_ENTRIES} entries.`,
      );
      return;
    }
    setDraft({ ...draft, [field]: [...draft[field], value] });
    setInput((current) => ({ ...current, [field]: "" }));
    setAnnouncement(`Added ${value}. Save vocabulary to keep it.`);
  };

  const remove = (field: VocabularyField, value: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            [field]: current[field].filter((item) => item !== value),
          }
        : current,
    );
    setAnnouncement(`Removed ${value}. Save vocabulary to keep this change.`);
  };

  const changed =
    saved != null && draft != null && vocabularyChanged(saved, draft);

  const save = async () => {
    if (!draft || !saved) return;
    ++requestSeq.current;
    setSaving(true);
    setError(null);
    try {
      const next = await saveTranscriptVocabulary(projectPath, {
        terms: draft.terms,
        guest_names: draft.guest_names,
        base_revision: saved.revision,
      });
      // Drop refresh GETs that started while the PUT was pending; `next` is newer.
      ++requestSeq.current;
      savedRef.current = next;
      setSaved(next);
      setDraft(next);
      setAnnouncement("Vocabulary saved.");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        replaceDraftOnLoad.current = true;
        // The reload drops unsaved entries, so stop announcing them as pending.
        setAnnouncement("");
        setError(VOCABULARY_CONFLICT_MESSAGE);
      } else {
        setError(errorMessage(reason));
      }
      // Re-issue the refresh this save superseded so saved state is not stale.
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="pipeline-vocabulary"
      aria-label="Transcription vocabulary"
    >
      <h3>Transcription vocabulary</h3>
      <p>
        Names and terms help Whisper recognize spellings during transcription.
      </p>
      {(["terms", "guest_names"] as const).map((field) => {
        const copy = FIELD_COPY[field];
        const inputId = `vocabulary-${field}`;
        return (
          <Field
            key={field}
            label={copy.label}
            htmlFor={inputId}
            className="pipeline-vocabulary-field"
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                add(field);
              }}
            >
              <input
                id={inputId}
                value={input[field]}
                maxLength={VOCABULARY_MAX_ENTRY_CHARS}
                disabled={!draft || saving}
                onChange={(event) =>
                  setInput((current) => ({
                    ...current,
                    [field]: event.target.value,
                  }))
                }
              />
              <Button
                type="submit"
                disabled={!draft || saving || !input[field].trim()}
              >
                Add {copy.noun}
              </Button>
            </form>
            <ul aria-label={copy.list}>
              {draft?.[field].map((value) => (
                <li key={value}>
                  {value}
                  <Button
                    className="ui-control--compact"
                    aria-label={`Remove ${value}`}
                    disabled={saving}
                    onClick={() => remove(field, value)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </Field>
        );
      })}
      <Button disabled={!changed || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save vocabulary"}
      </Button>
      {busy && changed && (
        <p className="pipeline-hint">
          A save during a run applies to the next transcription.
        </p>
      )}
      <p className="pipeline-ambient" aria-live="polite">
        {announcement}
      </p>
      {saved?.needs_retranscription && (
        <p role="status">
          Transcript needs re-transcription to use this vocabulary.{" "}
          <Button disabled={busy || saving || changed} onClick={onRetranscribe}>
            Re-transcribe
          </Button>
        </p>
      )}
      {error && <InlineError message={error} />}
      {error && !saved && <Button onClick={reload}>Retry</Button>}
    </section>
  );
}
