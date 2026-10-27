import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadTranscriptVocabulary,
  saveTranscriptVocabulary,
  type TranscriptVocabulary,
} from "../../api";
import { useDawStore } from "../../state/dawStore";
import { ApiError, errorMessage } from "../../utils/apiError";
import {
  type VocabularyLists,
  vocabularyChips,
  vocabularyFromChips,
} from "./prepareMappers";

export const VOCABULARY_CONFLICT =
  "Names and terms changed in another window. The latest list is shown.";

/**
 * The names and terms that help the transcriber. Every change is saved at
 * once, in order, so a quick run of edits is one write after another against
 * the revision the last write returned. A refused save (another window got
 * there first, or the list is over the prompt budget) says so and shows the
 * saved list again.
 */
export function useVocabulary(projectPath: string, refreshKey: string) {
  const [saved, setSaved] = useState<TranscriptVocabulary | null>(null);
  const [draft, setDraft] = useState<VocabularyLists | null>(null);
  const [reload, setReload] = useState(0);
  const latest = useRef({ projectPath, saved });
  latest.current = { projectPath, saved };
  const pending = useRef<VocabularyLists | null>(null);
  const revision = useRef<string | null>(null);
  const flushing = useRef(false);
  const sequence = useRef(0);

  // The refresh key moves when a run ends; a save in flight wins over its load.
  useEffect(() => {
    const seq = ++sequence.current;
    let live = true;
    void loadTranscriptVocabulary(projectPath)
      .then((value) => {
        if (!live || seq !== sequence.current) return;
        revision.current = value.revision;
        setSaved(value);
        setDraft(null);
      })
      .catch((error: unknown) => {
        if (live && seq === sequence.current) {
          useDawStore
            .getState()
            .announceStatus(
              `Could not load names and terms: ${errorMessage(error)}`,
              { tone: "error" },
            );
        }
      });
    return () => {
      live = false;
    };
  }, [projectPath, refreshKey, reload]);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        try {
          const result = await saveTranscriptVocabulary(
            latest.current.projectPath,
            { ...next, base_revision: revision.current },
          );
          sequence.current += 1;
          revision.current = result.revision;
          if (!pending.current) {
            setSaved(result);
            setDraft(null);
          }
        } catch (error) {
          pending.current = null;
          const conflict = error instanceof ApiError && error.status === 409;
          useDawStore
            .getState()
            .announceStatus(
              conflict ? VOCABULARY_CONFLICT : errorMessage(error),
              { tone: "error" },
            );
          setDraft(null);
          setReload((tick) => tick + 1);
        }
      }
    } finally {
      flushing.current = false;
    }
  }, []);

  const lists: VocabularyLists | null = draft ?? saved;
  const onTermsChange = useCallback(
    (chips: string[]) => {
      const base = draft ?? latest.current.saved;
      if (!base) return;
      const next = vocabularyFromChips(base, chips);
      setDraft(next);
      pending.current = next;
      void flush();
    },
    [draft, flush],
  );

  return {
    terms: lists ? vocabularyChips(lists) : [],
    ready: saved !== null,
    needsRetranscribe: saved?.needs_retranscription ?? false,
    onTermsChange,
  };
}
