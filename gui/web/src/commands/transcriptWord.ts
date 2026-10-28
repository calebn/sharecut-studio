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
    const chip = document.activeElement;
    if (
      !(chip instanceof HTMLElement) ||
      !chip.matches("button[data-transcript-word]") ||
      chip
        .closest("[data-transcript-intent]")
        ?.getAttribute("data-transcript-intent") !== "navigate"
    ) {
      return { status: "disabled", reason: "Focus a word in Navigate mode" };
    }
    const rawIndex = chip.dataset.wordIndex;
    return requestInlineEdit(
      chip.dataset.trackId ?? "",
      chip.dataset.sourceId || null,
      rawIndex ? Number(rawIndex) : Number.NaN,
    );
  });
}

/** Opens the inline fix for one timed word of a host project; the Fix text verb and F2 share it. */
export function requestInlineEdit(
  trackId: string,
  sourceId: string | null,
  wordIndex: number,
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
  });
  return { status: "ok" };
}
