import type { PersonData } from "../../../system/Person";
import type {
  CombinedUtterance,
  EditBoundaryView,
  PendingEditView,
  ProjectView,
  TrackView,
} from "../../../types/project";
import { wordsForUtterance } from "../../../utils/transcript";
import {
  buildScriptModel,
  type ScriptModel,
  type ScriptWordRef,
  speakerColorIndex,
  wordKey,
} from "./scriptModel";

export const NO_UTTERANCES: readonly CombinedUtterance[] = [];
export const NO_BOUNDARIES: readonly EditBoundaryView[] = [];
export const NO_PENDING: readonly PendingEditView[] = [];
export const NO_TRACKS: readonly TrackView[] = [];

export type ScriptHostModel = {
  model: ScriptModel;
  texts: readonly string[];
  silent: ReadonlySet<number>;
  unsure: readonly number[];
  hasWords: boolean;
};

export type ScriptModelSource = {
  utterances: readonly CombinedUtterance[];
  boundaries: readonly EditBoundaryView[];
  pending: readonly PendingEditView[];
  tracks: readonly TrackView[];
};

export function personOf(
  tracks: readonly TrackView[],
): (trackId: string, speaker: string) => PersonData {
  return (trackId, speaker) => {
    const at = tracks.findIndex((track) => track.id === trackId);
    return {
      name: speaker || tracks[at]?.speaker || trackId,
      colorIndex: speakerColorIndex(at),
    };
  };
}

export function scriptHostModelOf(
  source: ScriptModelSource,
  person: (trackId: string, speaker: string) => PersonData,
): ScriptHostModel {
  const { utterances, boundaries, pending } = source;
  const model = buildScriptModel({
    utterances,
    boundaries,
    pending,
    person,
  });
  const silent = new Set<number>();
  const cutAway = new Set<string>();
  for (const utterance of utterances) {
    for (const word of wordsForUtterance(utterance)) {
      if (word.word_index == null) continue;
      const ref: ScriptWordRef = {
        trackId: utterance.track_id,
        sourceId: utterance.source_id ?? null,
        wordIndex: word.word_index,
      };
      if (word.mappable === false) cutAway.add(wordKey(ref));
      if (!utterance.suppressed_only) continue;
      const index = model.indexOf(ref);
      if (index !== undefined) silent.add(index);
    }
  }
  const texts: string[] = [];
  const unsure: number[] = [];
  for (const turn of model.turns) {
    for (const word of turn.words) {
      texts[word.index] = word.text;
      if (
        word.lowConfidence &&
        !silent.has(word.index) &&
        model.refs[word.index]?.wordIndex != null &&
        !cutAway.has(wordKey(model.refs[word.index]))
      ) {
        unsure.push(word.index);
      }
    }
  }
  return { model, texts, silent, unsure, hasWords: model.refs.length > 0 };
}

export function scriptModelFor(project: ProjectView): ScriptHostModel {
  return scriptHostModelOf(
    {
      utterances: project.transcript?.utterances ?? NO_UTTERANCES,
      boundaries: project.edit_boundaries ?? NO_BOUNDARIES,
      pending: project.pending_edits,
      tracks: project.tracks,
    },
    personOf(project.tracks),
  );
}
