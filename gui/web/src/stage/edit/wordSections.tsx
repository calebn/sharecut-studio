import { RelatedCommands } from "../../inspector/RelatedCommands";
import { canHostMutate } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { RangeFields } from "../../timeline/RangeFields";
import type { Selection } from "../../types/project";
import { oneWordOf } from "../../utils/rangeSelect";
import { findTranscriptWord } from "../../utils/transcript";
import { WordFix } from "./WordFix";
import { WordActions, WordFacts, WordTiming } from "./WordParts";
import type { WordRef } from "./wordTarget";

const keyOf = ({ trackId, sourceId, wordIndex }: WordRef) =>
  JSON.stringify([trackId, sourceId, wordIndex]);

/**
 * The Inspector's content for a selected transcript range: the range actions,
 * and for a single word (host only, words hydrated) its facts, the Text and End
 * index fix, Suppress / Ignore, and the word's timing. A guest sees the range
 * only, as before.
 */
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
  const range: InspectorSection = {
    id: "range",
    rows: [{ id: "range", control: <RangeFields sheet /> }],
  };
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
    return [range, ...related];
  if (
    !project ||
    !findTranscriptWord(project, word.trackId, word.wordIndex, word.sourceId)
  )
    return [
      range,
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
  const sections: InspectorSection[] = [
    {
      id: "word",
      rows: [{ id: "facts", control: <WordFacts key={key} {...ref} /> }],
    },
    {
      id: "fix",
      rows: [{ id: "fix", control: <WordFix key={key} {...ref} /> }],
    },
    {
      id: "actions",
      rows: [
        { id: "actions", control: <WordActions key={key} {...ref} /> },
        { id: "timing", control: <WordTiming key={key} {...ref} /> },
      ],
    },
  ];
  // Correcting from the Script puts the fix first.
  const [facts, fix, rest] = sections as [
    InspectorSection,
    InspectorSection,
    InspectorSection,
  ];
  return correcting
    ? [fix, range, facts, rest, ...related]
    : [range, facts, fix, rest, ...related];
}
