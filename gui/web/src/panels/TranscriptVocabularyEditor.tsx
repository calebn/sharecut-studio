import { useEffect, useState } from "react";
import {
  loadTranscriptVocabulary,
  saveTranscriptVocabulary,
  type TranscriptVocabulary,
} from "../api";
import { Button, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";

type Field = "terms" | "guest_names";

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
  const [input, setInput] = useState<Record<Field, string>>({
    terms: "",
    guest_names: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadTranscriptVocabulary(projectPath)
      .then((value) => {
        if (active) {
          setSaved(value);
          setDraft(value);
        }
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [projectPath, refreshKey]);

  const add = (field: Field) => {
    const value = input[field].trim();
    if (!value || value.length > 100 || !draft) return;
    setDraft({
      ...draft,
      [field]: draft[field].includes(value)
        ? draft[field]
        : [...draft[field], value],
    });
    setInput((current) => ({ ...current, [field]: "" }));
  };

  const changed =
    saved != null &&
    draft != null &&
    (JSON.stringify(saved.terms) !== JSON.stringify(draft.terms) ||
      JSON.stringify(saved.guest_names) !== JSON.stringify(draft.guest_names));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const next = await saveTranscriptVocabulary(projectPath, draft);
      setSaved(next);
      setDraft(next);
    } catch (reason) {
      setError(errorMessage(reason));
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
      {(["terms", "guest_names"] as const).map((field) => (
        <div key={field} className="pipeline-vocabulary-field">
          <label htmlFor={`vocabulary-${field}`}>
            {field === "terms" ? "Terms" : "Guest names"}
          </label>
          <div>
            <input
              id={`vocabulary-${field}`}
              value={input[field]}
              maxLength={100}
              disabled={!draft || saving}
              onChange={(event) =>
                setInput((current) => ({
                  ...current,
                  [field]: event.target.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add(field);
                }
              }}
            />
            <Button
              disabled={!draft || saving || !input[field].trim()}
              onClick={() => add(field)}
            >
              Add {field === "terms" ? "term" : "guest name"}
            </Button>
          </div>
          <ul
            aria-label={field === "terms" ? "Saved terms" : "Saved guest names"}
          >
            {draft?.[field].map((value) => (
              <li key={value}>
                {value}{" "}
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  disabled={saving}
                  onClick={() =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            [field]: current[field].filter(
                              (item) => item !== value,
                            ),
                          }
                        : current,
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <Button disabled={!changed || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save vocabulary"}
      </Button>
      {saved?.needs_retranscription && (
        <p role="status">
          Transcript needs re-transcription to use this vocabulary.{" "}
          <Button disabled={busy || saving || changed} onClick={onRetranscribe}>
            Re-transcribe
          </Button>
        </p>
      )}
      {error && <InlineError message={error} />}
    </section>
  );
}
