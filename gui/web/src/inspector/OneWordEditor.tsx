import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import {
  oneWordOf,
  type TranscriptRangeSelection,
} from "../transcript/rangeSelect";
import { TranscriptWordInspector } from "./views/TranscriptWordInspector";

export function OneWordEditor({
  selection,
}: {
  selection: TranscriptRangeSelection;
}) {
  const { projectPath, hydrated } = useDaw((s) => ({
    projectPath: s.projectPath,
    hydrated: s.project?.meta.hydration?.transcript_words !== false,
  }));
  const word = oneWordOf(selection);
  if (!word || !hydrated || isShareProjectKey(projectPath)) return null;
  return (
    <TranscriptWordInspector
      key={JSON.stringify([word.trackId, word.sourceId, word.wordIndex])}
      trackId={word.trackId}
      sourceId={word.sourceId}
      wordIndex={word.wordIndex}
    />
  );
}
