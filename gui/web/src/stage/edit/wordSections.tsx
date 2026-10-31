import { RelatedCommands } from "../../inspector/RelatedCommands";
import { canHostMutate } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { Selection } from "../../types/project";
import { oneWordOf } from "../../utils/rangeSelect";
import { findTranscriptWord } from "../../utils/transcript";
import { rangeSection } from "./rangeSection";
import { WordFix } from "./WordFix";
import { WordActions, WordFacts, WordTiming } from "./WordParts";
import type { WordRef } from "./wordTarget";

const keyOf = ({ trackId, sourceId, wordIndex }: WordRef) =>
  JSON.stringify([trackId, sourceId, wordIndex]);

export function useWordSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { project, projectPath, hydrated, correcting, rangeArmed } = useDaw(
    (s) => ({
      project: s.project,
      projectPath: s.projectPath,
      hydrated: s.project?.meta.hydration?.transcript_words !== false,
      correcting: s.transcriptCorrecting,
      rangeArmed: s.rangeArmed,
    }),
  );
  if (selection?.kind !== "transcriptRange") return null;
  const word = oneWordOf(selection);
  const related: InspectorSection[] =
    rangeArmed || !word
      ? []
      : [
          {
            id: "related",
            rows: [
              {
                id: "related",
                control: <RelatedCommands selection={selection} />,
              },
            ],
          },
        ];
  if (!word || !hydrated || !canHostMutate(projectPath))
    return [rangeSection, ...related];
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
      ...related,
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
  const fix: InspectorSection = {
    id: "fix",
    rows: [{ id: "fix", control: <WordFix key={key} {...ref} /> }],
  };
  const rest: InspectorSection = {
    id: "actions",
    rows: [
      { id: "actions", control: <WordActions key={key} {...ref} /> },
      { id: "timing", control: <WordTiming key={key} {...ref} /> },
    ],
  };
  return correcting
    ? [fix, rangeSection, facts, rest, ...related]
    : [rangeSection, facts, fix, rest, ...related];
}
