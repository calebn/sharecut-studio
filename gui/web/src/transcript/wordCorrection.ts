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

/**
 * The draft the inspector should show right after a successful Apply
 * (#746): the word-index range the server actually wrote, and its trimmed
 * text. A single-word fix (`startWordIndex === endWordIndex`) keeps that one
 * index regardless of how many words the correction text contains. A phrase
 * fix's new end index comes from the token count of the applied text,
 * matching the backend's `_correct_phrase`, which re-indexes by
 * `new_text.split()`. The inspector uses this only to predict the End index;
 * it reads the baseline text back from the store after the host's result
 * lands.
 */
export function appliedCorrectionSpan(
  startWordIndex: number,
  endWordIndex: number,
  text: string,
): { endWordIndex: number; text: string } {
  const trimmed = text.trim();
  if (endWordIndex === startWordIndex) {
    return { endWordIndex: startWordIndex, text: trimmed };
  }
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return {
    endWordIndex: startWordIndex + Math.max(1, tokens.length) - 1,
    text: tokens.join(" "),
  };
}
