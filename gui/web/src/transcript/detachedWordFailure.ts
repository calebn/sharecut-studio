import { useDawStore } from "../state/dawStore";
import type { TranscriptInlineEditFailure } from "../state/types";
import type { TranscriptWordView } from "../types/project";
import { errorMessage } from "../utils/apiError";

/** What failed on the word: a text fix, or a Suppress / Ignore toggle. */
export type DetachedWordAction = "fix" | "suppressed" | "ignored";

export interface DetachedWordFailureInput {
  projectPath: string;
  trackId: string;
  wordIndex: number;
  /** The word as it was when the action was submitted. */
  word: Pick<TranscriptWordView, "text" | "suppressed" | "ignored">;
  action: DetachedWordAction;
  failure: unknown;
}

/** The late-failure banner entry for a word action that failed after its editor unmounted. */
export function detachedWordFailure({
  projectPath,
  trackId,
  wordIndex,
  word,
  action,
  failure,
}: DetachedWordFailureInput): TranscriptInlineEditFailure {
  const verb = action === "fix" ? "fix" : "update";
  return {
    projectPath,
    trackId,
    wordIndex,
    originalText: word.text,
    message: `Could not ${verb} “${word.text}”: ${errorMessage(failure)}`,
  };
}

/**
 * Store a detached failure for the transcript's late-failure banner. It lives
 * in the DAW store, so it outlives the editor and the transcript panel.
 */
export function reportDetachedWordFailure(
  input: DetachedWordFailureInput,
): void {
  useDawStore
    .getState()
    .setTranscriptInlineEditFailure(detachedWordFailure(input));
}

/**
 * True once a late failure no longer applies: another project is open, the
 * word is gone, or its text changed by any path (inspector Apply, a later
 * inline fix, a remote edit).
 */
export function isDetachedWordFailureMoot(
  failure: TranscriptInlineEditFailure,
  projectPath: string,
  word: Pick<TranscriptWordView, "text" | "suppressed" | "ignored"> | null,
): boolean {
  return (
    failure.projectPath !== projectPath || word?.text !== failure.originalText
  );
}
