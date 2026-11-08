import type { TranscriptDetailView } from "../document/useTranscriptDetail";
import {
  filterCounts,
  type ReviewFilter,
  type ReviewItem,
  undecidedOf,
} from "./reviewQueueModel";

export type ReviewDetailKind = TranscriptDetailView["kind"] | undefined;

export type ReviewCompleteness = {
  counts: Record<ReviewFilter, number | null>;
  total: number | null;
  undecided: number | null;
  wordsKnown: boolean;
  unavailableMessage: string | null;
};

const unavailableMessageOf = (detail: ReviewDetailKind) =>
  detail === "pending"
    ? "Transcript words are loading."
    : detail === "failed"
      ? "Transcript words could not be loaded."
      : detail === "hidden"
        ? "Transcript words are unavailable here."
        : null;

export function reviewCompletenessOf(
  items: readonly ReviewItem[],
  detail: ReviewDetailKind,
  speaker: string | null = null,
): ReviewCompleteness {
  const counts = filterCounts(items, speaker);
  const wordsKnown = detail === undefined || detail === "ready";
  const unavailableMessage = unavailableMessageOf(detail);
  return {
    counts: wordsKnown ? counts : { ...counts, all: null, checks: null },
    total: wordsKnown ? items.length : null,
    undecided: wordsKnown ? undecidedOf(items) : null,
    wordsKnown,
    unavailableMessage,
  };
}

export function reviewSubsetCount(
  count: number,
  detail: ReviewDetailKind,
  includesWords = false,
): number | null {
  if (detail !== undefined && detail !== "ready" && includesWords) return null;
  return count;
}
