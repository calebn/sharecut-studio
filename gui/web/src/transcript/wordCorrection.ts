import { correctTranscriptPhrase, correctTranscriptWord } from "../api";

/** Why a correction cannot be sent, or null when it can. */
export function wordCorrectionError(
  text: string,
  startWordIndex: number,
  endWordIndex: number,
): string | null {
  if (!Number.isInteger(endWordIndex) || endWordIndex < startWordIndex) {
    return "End index must be an integer ≥ start word index";
  }
  if (!text.trim()) {
    return "Text cannot be empty";
  }
  return null;
}

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
): Promise<void> {
  const next = text.trim();
  if (endWordIndex === startWordIndex) {
    await correctTranscriptWord(
      projectPath,
      trackId,
      startWordIndex,
      next,
      expectedText,
    );
    return;
  }
  await correctTranscriptPhrase(
    projectPath,
    trackId,
    startWordIndex,
    endWordIndex,
    next,
    expectedText,
  );
}
