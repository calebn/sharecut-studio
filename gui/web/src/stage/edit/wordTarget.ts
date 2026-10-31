import { useMemo } from "react";
import { useMountedRef } from "../../hooks/useMountedRef";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import {
  type DetachedWordAction,
  reportDetachedWordFailure,
} from "../../transcript/detachedWordFailure";
import type { HistoryEntryId } from "../../types/project";
import {
  findTranscriptWord,
  spanTextFromIndex,
  type TrackWordTexts,
  trackWordTexts,
} from "../../utils/transcript";

export type WordRef = {
  trackId: string;
  sourceId: string | null;
  wordIndex: number;
};

/** Empty `TrackWordTexts` while transcript words are not hydrated yet. */
const NO_WORD_TEXTS: TrackWordTexts = new Map();

/**
 * One word in the project and the busy/error state of the actions on it. Each
 * part of the word's sheet content is keyed by the word, so a failure that
 * settles after the selection moved goes to the transcript's late-failure
 * banner instead of being lost or shown under the next word.
 */
export function useWordTarget({ trackId, sourceId, wordIndex }: WordRef) {
  const { project, projectPath } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
  }));
  const hydrated = project?.meta.hydration?.transcript_words !== false;
  const word = useMemo(
    () =>
      project && hydrated
        ? findTranscriptWord(project, trackId, wordIndex, sourceId)
        : null,
    [project, trackId, sourceId, wordIndex, hydrated],
  );
  // Word texts under the shared duplicate-index rule (#650): a disagreeing
  // duplicate maps to null. Built once per snapshot so End index is O(span).
  const wordTexts = useMemo(
    () =>
      project && hydrated
        ? trackWordTexts(project, trackId, sourceId)
        : NO_WORD_TEXTS,
    [project, trackId, sourceId, hydrated],
  );
  const wordSpanText = spanTextFromIndex(wordTexts, wordIndex, wordIndex);
  const mutation = useProjectMutation();
  const mounted = useMountedRef();
  const runForWord = async (
    action: DetachedWordAction,
    fn: () => Promise<HistoryEntryId | null>,
    done: string,
  ): Promise<{ failed: boolean; failure: unknown }> => {
    const before = {
      text: word?.text ?? "",
      suppressed: Boolean(word?.suppressed),
      ignored: Boolean(word?.ignored),
      audibility_locked: Boolean(word?.audibility_locked),
    };
    let failure: unknown;
    let failed = false;
    await mutation.run(async () => {
      try {
        const historyHead = await fn();
        useDawStore.getState().announceStatus(done, { undo: historyHead });
      } catch (e) {
        failed = true;
        failure = e;
        throw e;
      }
    });
    if (failed && !mounted.current) {
      reportDetachedWordFailure({
        projectPath,
        trackId,
        sourceId,
        wordIndex,
        word: before,
        action,
        failure,
      });
    }
    return { failed, failure };
  };
  return {
    word,
    wordTexts,
    wordSpanText,
    hydrated,
    ...mutation,
    runForWord,
  };
}
