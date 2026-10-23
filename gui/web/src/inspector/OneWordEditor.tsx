import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { RangeActions } from "../timeline/RangeActions";
import { oneWordOf, type TranscriptRangeSelection } from "../utils/rangeSelect";
import { TranscriptWordInspector } from "./views/TranscriptWordInspector";

function OneWordEditor({
  selection,
  presentation = "standard",
}: {
  selection: TranscriptRangeSelection;
  presentation?: "standard" | "correct-sheet";
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
      presentation={presentation}
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
  const correcting = useDaw((s) => s.transcriptCorrecting);
  const correctionFirst =
    placement === "sheet" && correcting && oneWordOf(selection) != null;
  const editor = (
    <OneWordEditor
      key="word"
      selection={selection}
      presentation={correctionFirst ? "correct-sheet" : "standard"}
    />
  );
  const range =
    placement === "sheet" ? <RangeActions key="range" sheet /> : null;
  return correctionFirst ? (
    <>
      {editor}
      {range}
    </>
  ) : (
    <>
      {range}
      {editor}
    </>
  );
}
