import { correctTranscriptPhrase, correctTranscriptWord } from "../api";
import type { HistoryEntryId } from "../types/project";

/**
 * Send a single-word (start === end) or phrase correction as one document
 * command (EditService → ProjectWorkspace.mutate: one undoable step).
 *
 * @param expectedText the text the user saw at these indices; the server refuses the fix
 * with a 409 when it changed (#650).
 */
export async function submitWordCorrection(
  projectPath: string,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  text: string,
  expectedText?: string | null,
  sourceId?: string | null,
): Promise<HistoryEntryId | null> {
  const next = text.trim();
  if (endWordIndex === startWordIndex) {
    return sourceId == null
      ? correctTranscriptWord(
          projectPath,
          trackId,
          startWordIndex,
          next,
          expectedText,
        )
      : correctTranscriptWord(
          projectPath,
          trackId,
          startWordIndex,
          next,
          expectedText,
          sourceId,
        );
  }
  return sourceId == null
    ? correctTranscriptPhrase(
        projectPath,
        trackId,
        startWordIndex,
        endWordIndex,
        next,
        expectedText,
      )
    : correctTranscriptPhrase(
        projectPath,
        trackId,
        startWordIndex,
        endWordIndex,
        next,
        expectedText,
        sourceId,
      );
}
