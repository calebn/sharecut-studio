import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { oneWordOf } from "../utils/rangeSelect";
import { findTranscriptWord, wordSeekSec } from "../utils/transcript";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

export function registerTranscriptWordCommands(): void {
  registerCommand("transcript.adjustTiming", (args) => {
    const s = useDawStore.getState();
    if (
      !s.project ||
      isShareProjectKey(s.projectPath) ||
      s.project.meta.hydration?.transcript_words === false
    )
      return { status: "disabled", reason: "Hydrated host project required" };
    const word = oneWordOf(s.selection);
    const trackId =
      typeof args.trackId === "string" ? args.trackId : (word?.trackId ?? null);
    const wordIndex =
      typeof args.wordIndex === "number"
        ? args.wordIndex
        : (word?.wordIndex ?? null);
    const sourceId =
      typeof args.sourceId === "string" || args.sourceId === null
        ? args.sourceId
        : (word?.sourceId ?? null);
    if (
      trackId == null ||
      wordIndex == null ||
      !findTranscriptWord(s.project, trackId, wordIndex, sourceId)
        ?.timing_target
    )
      return { status: "disabled", reason: "Select a source transcript word" };
    s.setTranscriptTimingRequest({
      projectPath: s.projectPath,
      trackId,
      sourceId,
      wordIndex,
    });
    return { status: "ok" };
  });
  registerCommand("transcript.editWordInline", () => {
    const s = useDawStore.getState();
    if (!s.project || isShareProjectKey(s.projectPath))
      return { status: "disabled", reason: "Host project required" };
    const sel = s.selection;
    if (sel?.kind !== "transcriptRange")
      return { status: "disabled", reason: "Select words to fix" };
    return requestInlineEdit(
      sel.trackId,
      sel.sourceId ?? null,
      sel.startWordIndex,
      sel.endWordIndex,
    );
  });
}

export function requestInlineEdit(
  trackId: string,
  sourceId: string | null,
  wordIndex: number,
  endWordIndex: number = wordIndex,
): ExecuteResult {
  const s = useDawStore.getState();
  if (!s.project || isShareProjectKey(s.projectPath))
    return { status: "disabled", reason: "Host project required" };
  if (
    !trackId ||
    !Number.isInteger(wordIndex) ||
    wordIndex < 0 ||
    s.project.meta.hydration?.transcript_words === false ||
    s.transcriptInlineCommitPending
  ) {
    return { status: "disabled", reason: "Word correction unavailable" };
  }
  const word = findTranscriptWord(s.project, trackId, wordIndex, sourceId);
  if (!word || wordSeekSec(word) == null)
    return { status: "disabled", reason: "Word is not timed" };
  s.setTranscriptInlineEditRequest({
    projectPath: s.projectPath,
    trackId,
    sourceId,
    wordIndex,
    ...(endWordIndex !== wordIndex ? { endWordIndex } : {}),
  });
  return { status: "ok" };
}
