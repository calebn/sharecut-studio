import { canHostMutate } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { oneWordOf } from "../../utils/rangeSelect";
import { findTranscriptWord } from "../../utils/transcript";
import { passageRangeSection, rangeSection } from "./rangeSection";
import { WordActions, WordFacts, WordTiming } from "./WordParts";
import type { WordRef } from "./wordTarget";

const keyOf = ({ trackId, sourceId, wordIndex }: WordRef) =>
  JSON.stringify([trackId, sourceId, wordIndex]);

export function useWordSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { project, projectPath, hydrated } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    hydrated: s.project?.meta.hydration?.transcript_words !== false,
  }));
  if (selection?.kind !== "transcriptRange") return null;
  const word = oneWordOf(selection);
  if (!word) return [passageRangeSection];
  if (!hydrated || !canHostMutate(projectPath)) return [rangeSection];
  if (
    !project ||
    !findTranscriptWord(project, word.trackId, word.wordIndex, word.sourceId)
  )
    return [
      rangeSection,
      {
        id: "gone",
        rows: [
          {
            id: "gone",
            control: <p className="ui-field-hint">Transcript word not found</p>,
          },
        ],
      },
    ];
  const ref: WordRef = {
    trackId: word.trackId,
    sourceId: word.sourceId,
    wordIndex: word.wordIndex,
  };
  const key = keyOf(ref);
  const facts: InspectorSection = {
    id: "word",
    rows: [{ id: "facts", control: <WordFacts key={key} {...ref} /> }],
  };
  const rest: InspectorSection = {
    id: "actions",
    rows: [
      { id: "actions", control: <WordActions key={key} {...ref} /> },
      { id: "timing", control: <WordTiming key={key} {...ref} /> },
    ],
  };
  return [rangeSection, facts, rest];
}
