import { useCallback, useMemo } from "react";
import { useDawStore } from "../../../state/dawStore";
import type { PersonData } from "../../../system/Person";
import type {
  CombinedUtterance,
  EditBoundaryView,
  PendingEditView,
  TrackView,
} from "../../../types/project";
import { wordsForUtterance } from "../../../utils/transcript";
import {
  buildScriptModel,
  type ScriptModel,
  type ScriptWordRef,
} from "./scriptModel";

const NO_UTTERANCES: readonly CombinedUtterance[] = [];
const NO_BOUNDARIES: readonly EditBoundaryView[] = [];
const NO_PENDING: readonly PendingEditView[] = [];
const NO_TRACKS: readonly TrackView[] = [];
const COLORS = 8;

export type ScriptHostModel = {
  model: ScriptModel;
  /** The text of each word, by window index. */
  texts: readonly string[];
  /** Window indices of words that sit only in a muted bleed row: never active, never unsure. */
  silent: ReadonlySet<number>;
  /** Window indices of the words the transcript is unsure of, in order, bleed rows excluded. */
  unsure: readonly number[];
  hasWords: boolean;
};

/**
 * The project's transcript as the Script pane's model. One field per store
 * read, and the model is rebuilt only when the utterances, cuts, suggestions
 * or tracks change, never on a playhead tick.
 */
export function useScriptModel(): ScriptHostModel {
  const utterances =
    useDawStore((s) => s.project?.transcript?.utterances) ?? NO_UTTERANCES;
  const boundaries =
    useDawStore((s) => s.project?.edit_boundaries) ?? NO_BOUNDARIES;
  const pending = useDawStore((s) => s.project?.pending_edits) ?? NO_PENDING;
  const tracks = useDawStore((s) => s.project?.tracks) ?? NO_TRACKS;

  const person = useCallback(
    (trackId: string, speaker: string): PersonData => {
      const at = tracks.findIndex((track) => track.id === trackId);
      return {
        name: speaker || tracks[at]?.speaker || trackId,
        colorIndex: Math.max(at, 0) % COLORS,
      };
    },
    [tracks],
  );

  return useMemo(() => {
    const model = buildScriptModel({
      utterances,
      boundaries,
      pending,
      person,
    });
    const silent = new Set<number>();
    for (const utterance of utterances) {
      if (!utterance.suppressed_only) continue;
      for (const [at, word] of wordsForUtterance(utterance).entries()) {
        const ref: ScriptWordRef = {
          trackId: utterance.track_id,
          sourceId: utterance.source_id ?? null,
          wordIndex: word.word_index ?? at,
        };
        const index = model.indexOf(ref);
        if (index !== undefined) silent.add(index);
      }
    }
    const texts: string[] = [];
    const unsure: number[] = [];
    for (const turn of model.turns) {
      for (const word of turn.words) {
        texts[word.index] = word.text;
        if (word.lowConfidence && !silent.has(word.index)) {
          unsure.push(word.index);
        }
      }
    }
    return { model, texts, silent, unsure, hasWords: model.refs.length > 0 };
  }, [utterances, boundaries, pending, person]);
}
