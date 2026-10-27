/** Plain-language names for a pending edit's type and reason code. */

import type { PendingEditView, PendingKind, TrackView } from "../types/project";
import { knownPendingKind, markerLabel } from "./editMarkerRegistry";
import { capitalize } from "./format";
import type { TightenClass } from "./tightenHits";
import { clockLabel } from "./time";

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

/** Reason-flag suffixes on an acoustic hit, most cautious first; mirrors `ACOUSTIC_KIND_FLAGS` in `tighten_reasons.py`. */
const ACOUSTIC_FLAG_LABELS: readonly (readonly [string, string])[] = [
  ["possible_word", "Possible missed word"],
  ["likely_laugh", "Likely laugh"],
];

/** One label per tighten class; a new class in `tightenHits` fails to type-check until it has one. */
const TIGHTEN_REASON_LABELS: Record<TightenClass, (tail: string) => string> = {
  filler: (tail) => `Filler word "${tail}"`,
  pause: (tail) => (tail ? `Long pause (${tail})` : "Long pause"),
  repeat: () => "Repeated word",
  "false-start": () => "False start",
  sound: (tail) => {
    const flags = tail.split(":");
    const flagged = ACOUSTIC_FLAG_LABELS.find(([flag]) => flags.includes(flag));
    return flagged ? flagged[1] : "Filler sound";
  },
};

export function pendingTypeLabel(type: string): string {
  const kind = knownPendingKind(type);
  return kind ? markerLabel(kind) : capitalize(type);
}

export function pendingListRowLabel(
  edit: PendingEditView,
  tracks: readonly TrackView[],
): string {
  const track = tracks.find((t) => t.id === edit.track_id);
  const who = track?.speaker ?? track?.label ?? edit.track_id;
  const kind = edit.kind === "pause" ? "pause trim" : "cut";
  const at = clockLabel(edit.source_start);
  const detail =
    pendingReasonLabel(edit.reason, edit.kind) ?? pendingTypeLabel(edit.type);
  return `${who}'s ${kind} at ${at} · ${detail}`;
}

/**
 * A plain label for a reason code. The server's `kind` picks the label; the reason only supplies
 * the detail after its first colon (the filler word, the pause length), never the grouping.
 */
export function pendingReasonLabel(
  reason: string | null | undefined,
  kind: PendingKind,
): string {
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
  if (kind !== "other") {
    return TIGHTEN_REASON_LABELS[kind](reason.slice(reason.indexOf(":") + 1));
  }
  return reason;
}

/** Shown when Approve/Reject was saved but is still waiting to send. */
export const PENDING_REVIEW_QUEUED_MESSAGE =
  "Still sending. It will retry automatically; if the host refuses it, it shows under Needs attention.";
