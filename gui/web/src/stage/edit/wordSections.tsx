import { canHostMutate } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import { DotMeter } from "../../system/DotMeter";
import type { InspectorSection } from "../../system/InspectorSheet";
import { isSuspectHallucinationWord } from "../../transcript/lowConfidence";
import {
  TRANSCRIPT_AUDIBILITY_LOCKED_TIP,
  TRANSCRIPT_SUSPECT_HALLUCINATION_TIP,
} from "../../transcript/transcriptModeCopy";
import type { Selection } from "../../types/project";
import { oneWordOf } from "../../utils/rangeSelect";
import { findTranscriptWord } from "../../utils/transcript";
import { passageRangeSection, rangeSection } from "./rangeSection";
import { note } from "./sheetNote";
import { WordActions, WordTiming } from "./WordParts";
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
  const shown = findTranscriptWord(
    project,
    word.trackId,
    word.wordIndex,
    word.sourceId,
  );
  if (!shown)
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
    rows: [
      { id: "text", label: "Text", control: <span>{shown.text}</span> },
      ...(shown.confidence != null
        ? [
            {
              id: "confidence",
              control: (
                <DotMeter
                  label="Confidence"
                  value={shown.confidence}
                  showLabel={false}
                />
              ),
            },
          ]
        : []),
      ...(isSuspectHallucinationWord(shown)
        ? [
            {
              id: "hint",
              control: note(TRANSCRIPT_SUSPECT_HALLUCINATION_TIP),
            },
          ]
        : []),
      ...(shown.audibility_locked
        ? [{ id: "locked", control: note(TRANSCRIPT_AUDIBILITY_LOCKED_TIP) }]
        : []),
    ],
  };
  const rest: InspectorSection = {
    id: "actions",
    rows: [
      { id: "timing", control: <WordTiming key={key} {...ref} /> },
      { id: "actions", control: <WordActions key={key} {...ref} /> },
    ],
  };
  return [rangeSection, facts, rest];
}
