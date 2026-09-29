import { useDawStore } from "../state/dawStore";
import type { TranscriptInlineEditFailure } from "../state/types";
import type {
  TranscriptWordBooleanFlag,
  TranscriptWordView,
} from "../types/project";
import { errorMessage } from "../utils/apiError";

/** Text corrections and boolean actions whose late failures can become moot. */
export type DetachedWordAction = "fix" | TranscriptWordBooleanFlag;

/** Fields captured when an action starts and compared when its late failure is shown. */
export type DetachedWordSnapshot = Pick<
  TranscriptWordView,
  "text" | "suppressed" | "ignored" | "audibility_locked"
>;

export interface DetachedWordFailureInput {
  projectPath: string;
  trackId: string;
  wordIndex: number;
  /** The word as it was when the action was submitted. */
  word: DetachedWordSnapshot;
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
    ...(action === "fix"
      ? {}
      : { flag: { name: action, was: Boolean(word[action]) } }),
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
 * word is gone, its text changed by any path (inspector Apply, a later
 * inline fix, a remote edit), or, for a failed Suppress / Ignore / Return to
 * automatic, that flag changed (a retry succeeded).
 */
export function isDetachedWordFailureMoot(
  failure: TranscriptInlineEditFailure,
  projectPath: string,
  word: DetachedWordSnapshot | null,
): boolean {
  if (failure.projectPath !== projectPath || !word) return true;
  if (word.text !== failure.originalText) return true;
  return (
    failure.flag != null &&
    Boolean(word[failure.flag.name]) !== failure.flag.was
  );
}
