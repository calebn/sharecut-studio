import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { RangeFields } from "../timeline/RangeFields";
import { oneWordOf, type TranscriptRangeSelection } from "../utils/rangeSelect";
import { TranscriptWordInspector } from "./views/TranscriptWordInspector";

function OneWordEditor({ selection }: { selection: TranscriptRangeSelection }) {
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

export function TranscriptRangeBody({
  selection,
  placement,
}: {
  selection: TranscriptRangeSelection;
  placement: "rail" | "sheet";
}) {
  return (
    <>
      {placement === "sheet" ? <RangeFields sheet /> : null}
      <OneWordEditor selection={selection} />
    </>
  );
}
