import { correctTranscriptPhrase, correctTranscriptWord } from "../api";
import { spanTextFromIndex, type TrackWordTexts } from "../utils/transcript";

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

/** A word-index span on one track, from a fixed start: its end and the text it held (#746). */
export interface CorrectionSpan {
  endWordIndex: number;
  text: string;
}

/**
 * The span an Apply replaced. `text` is null when that Apply went out
 * unguarded because the span was unverified (#650): a word not loaded, a
 * disagreeing duplicate, or a baseline the store did not read back (#746).
 */
export interface ReplacedSpan {
  endWordIndex: number;
  text: string | null;
}

/** One successful Apply: the span it replaced (text null if it was sent unguarded) and the span it wrote. */
export interface AppliedCorrection {
  before: ReplacedSpan;
  after: CorrectionSpan;
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
): CorrectionSpan {
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

/**
 * The baseline to move to when the current one no longer matches the words
 * because they went back to a span this inspector itself applied or replaced:
 * an Undo or Redo of one of its own Applies (#746). Walks `applied` newest
 * first. When `current` is an Apply's `after` and the words now read its
 * `before`, it returns `before` (Undo); the reverse returns `after` (Redo).
 * Returns null when `current` still matches the words, or when they changed
 * to anything else, so a peer's edit still fails the stale-text guard.
 * When that Apply was sent unguarded (before.text null), any move away from
 * its after returns that unverified before, so the next Apply sends no text
 * (the hint under Apply shows) instead of a stale baseline.
 */
export function reconciledCorrectionBaseline(
  texts: TrackWordTexts,
  startWordIndex: number,
  current: CorrectionSpan,
  applied: readonly AppliedCorrection[],
): ReplacedSpan | null {
  const reads = (span: ReplacedSpan) =>
    spanTextFromIndex(texts, startWordIndex, span.endWordIndex) === span.text;
  const same = (a: ReplacedSpan, b: ReplacedSpan) =>
    a.endWordIndex === b.endWordIndex && a.text === b.text;
  if (reads(current)) {
    return null;
  }
  for (const { before, after } of [...applied].reverse()) {
    // An Apply sent unguarded has no text to check its Undo against: once
    // the words leave what it wrote, go back to sending none, as before it.
    if (same(current, after) && (before.text == null || reads(before))) {
      return before;
    }
    if (same(current, before) && reads(after)) {
      return after;
    }
  }
  return null;
}
