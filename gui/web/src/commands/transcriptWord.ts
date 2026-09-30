import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { findTranscriptWord, wordSeekSec } from "../utils/transcript";
import { registerCommand } from "./execute";

export function registerTranscriptWordCommands(): void {
  registerCommand("transcript.adjustTiming", (args) => {
    const s = useDawStore.getState();
    if (
      !s.project ||
      isShareProjectKey(s.projectPath) ||
      s.project.meta.hydration?.transcript_words === false
    )
      return { status: "disabled", reason: "Hydrated host project required" };
    const selection = s.selection;
    const trackId =
      typeof args.trackId === "string"
        ? args.trackId
        : selection?.kind === "transcriptWord"
          ? selection.trackId
          : null;
    const wordIndex =
      typeof args.wordIndex === "number"
        ? args.wordIndex
        : selection?.kind === "transcriptWord"
          ? selection.wordIndex
          : null;
    if (
      trackId == null ||
      wordIndex == null ||
      !findTranscriptWord(s.project, trackId, wordIndex)?.timing_target
    )
      return { status: "disabled", reason: "Select a source transcript word" };
    s.setTranscriptTimingRequest({
      projectPath: s.projectPath,
      trackId,
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
    const trackId = chip.dataset.trackId;
    const rawIndex = chip.dataset.wordIndex;
    const wordIndex = Number(rawIndex);
    if (
      !trackId ||
      !rawIndex ||
      !Number.isInteger(wordIndex) ||
      wordIndex < 0 ||
      s.project?.meta.hydration?.transcript_words === false ||
      s.transcriptInlineCommitPending
    ) {
      return { status: "disabled", reason: "Word correction unavailable" };
    }
    const word = findTranscriptWord(s.project, trackId, wordIndex);
    if (!word || wordSeekSec(word) == null)
      return { status: "disabled", reason: "Word is not timed" };
    s.setTranscriptInlineEditRequest({
      projectPath: s.projectPath,
      trackId,
      wordIndex,
    });
    return { status: "ok" };
  });
}
