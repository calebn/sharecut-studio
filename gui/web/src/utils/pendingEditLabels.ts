/** Plain-language names for a pending edit's type and reason code. */

import { capitalize } from "./format";
import { type TightenClass, tightenClassOfReason } from "./tightenHits";

const TYPE_LABELS: Record<string, string> = {
  remove: "Cut",
  mute: "Mute",
  split: "Split",
};

// Keys mirror src/podcast_mcp/edits/edit_reasons.py; tests/test_edit_reasons.py fails when one is missing.
const REASON_LABELS: Record<string, string> = {
  "guest:suggest": "Suggested by guest",
  "guest:suggest_split": "Split suggested by guest",
  "guest:suggest_delete": "Delete suggested by guest",
  "guest:suggest_ripple_delete": "Ripple delete suggested by guest",
  "nl:range": "Agent edit (time range)",
  "nl:manual": "Agent edit",
  "nl:words": "Agent edit (selected words)",
  other: "Other",
};

/** One label per tighten class; a new class in `tightenHits` fails to type-check until it has one. */
const TIGHTEN_REASON_LABELS: Record<TightenClass, (tail: string) => string> = {
  filler: (tail) =>
    tail === "acoustic" ? "Filler sound" : `Filler word "${tail}"`,
  pause: (tail) => (tail ? `Long pause (${tail})` : "Long pause"),
  repetition: () => "Repeated word",
  restart: () => "False start",
};

export function pendingTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? capitalize(type);
}

export function pendingReasonLabel(reason: string | null | undefined): string {
  if (!reason) {
    return "No reason given";
  }
  const exact = REASON_LABELS[reason];
  if (exact) {
    return exact;
  }
  if (reason.startsWith("nl:match:")) {
    return "Agent edit (matched text)";
  }
  if (reason.startsWith("nl:utterance:")) {
    return "Agent edit (utterance)";
  }
  const tightenClass = tightenClassOfReason(reason);
  if (tightenClass) {
    return TIGHTEN_REASON_LABELS[tightenClass](
      reason.slice(tightenClass.length + 1),
    );
  }
  return reason;
}
