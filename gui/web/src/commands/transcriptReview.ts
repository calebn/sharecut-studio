import { presenceAnchor } from "../presence/anchors";
import { useDawStore } from "../state/dawStore";
import {
  type ReviewDirection,
  selectLowConfidenceStops,
  stepLowConfidence,
} from "../transcript/lowConfidence";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

function stepReview(direction: ReviewDirection): ExecuteResult {
  const s = useDawStore.getState();
  if (!s.project) return { status: "disabled", reason: "No project loaded" };
  const stops = selectLowConfidenceStops(
    s.project.transcript?.utterances ?? [],
    s.transcriptAnnotate,
    s.showCutAwayUtterances,
  );
  const index = stepLowConfidence(stops, s.transcriptReviewCursor, direction);
  const stop = stops[index];
  if (!stop) return { status: "disabled", reason: "No low-confidence words" };
  // Annotate draws the underline; turning it on never changes the stop list
  // (Show cut away is off whenever Annotate is).
  if (!s.transcriptAnnotate) s.setTranscriptAnnotate(true);
  s.setTranscriptReviewCursor({
    trackId: stop.trackId,
    wordIndex: stop.wordIndex,
    order: stop.order,
  });
  if (stop.seekSec != null) s.setPlayheadSec(stop.seekSec);
  s.setTranscriptScrollRequest(
    presenceAnchor("transcript", "word", stop.trackId, stop.wordIndex),
  );
  s.announceStatus(
    `Low-confidence word ${index + 1} of ${stops.length}: ${stop.text}`,
  );
  return { status: "ok" };
}

/** `transcript.next/prevLowConfidence` (#634): walk the Annotate low-confidence words in transcript order, wrapping. */
export function registerTranscriptReviewCommands(): void {
  registerCommand("transcript.nextLowConfidence", () => stepReview("next"));
  registerCommand("transcript.prevLowConfidence", () => stepReview("prev"));
}
