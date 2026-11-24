/** Plain-language names for a pending edit's type and reason code. */

import type { PendingEditView, PendingKind, TrackView } from "../types/project";
import {
  ApiError,
  CUT_SCOPE_CHANGED_CODE,
  isDeadLinkAnswer,
  isPermanentRejection,
} from "./apiError";
import { knownPendingKind, markerLabel } from "./editMarkerRegistry";
import { capitalize } from "./format";
import { isTightenClass, type TightenClass } from "./tightenHits";
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
  // An older host or stale snapshot may send no kind or one this client does not know.
  if (isTightenClass(kind)) {
    return TIGHTEN_REASON_LABELS[kind](reason.slice(reason.indexOf(":") + 1));
  }
  return reason;
}

/** Shown when Approve/Reject was saved but is still waiting to send. */
export const PENDING_REVIEW_QUEUED_MESSAGE =
  "Still sending. It will retry automatically; if the host refuses it, it shows under Needs attention.";

/** What an unsent or unpersisted save says: no server text, and the edge is back. */
const unsavedRetime = (edge: "start" | "end") =>
  `That edit's ${edge} could not be saved right now, so it is back where it was. Try moving it again in a moment.`;

/**
 * One plain sentence for a failed save of a dragged pending-edit edge: what was not saved and what
 * to do next. The server's own text is never shown. A permanent 4xx refusal and a project-level
 * problem name their cause; a retry-later 408/429, a 5xx or a transport error (only seen when the
 * save could not be kept for retry) says the save could not be made right now.
 */
export function pendingRetimeRefusal(
  error: unknown,
  edge: "start" | "end",
): string {
  const code = error instanceof ApiError ? error.code : null;
  switch (code) {
    case "project_version_newer":
      return "This project was saved by a newer version of the app, so nothing was changed and the edge is back where it was. Update the app, then try again.";
    case "project_version_unsupported":
      return "This app can't edit this project's version, so nothing was changed and the edge is back where it was.";
    case "project_not_found":
      return "The project file is missing, so nothing was saved and the edge is back where it was.";
    case "project_unreadable":
      return "The project file is damaged, so nothing was saved and the edge is back where it was.";
  }
  if (!isPermanentRejection(error)) return unsavedRetime(edge);
  const status = error instanceof ApiError ? error.status : null;
  // A revoked or expired share, or a sign-in that lapsed: retrying the same edge cannot help.
  if (status === 401 || status === 403 || isDeadLinkAnswer(status, code)) {
    return "You can no longer change this edit, so nothing was saved and the edge is back where it was. Sign in again or ask the host for access.";
  }
  switch (code) {
    case CUT_SCOPE_CHANGED_CODE:
      return "The range changed after this suggestion was made, so it needs review again and the edge is back where it was.";
    case "exact_range_locked":
      return "This range is exact and can't be moved by its edges. Select the range again.";
    case "edit_not_found":
    case "pending_edit_not_found":
      return "That suggestion is gone, so nothing was saved.";
    case "range_end_before_start":
      return `The end must come after the start, so the ${edge} is back where it was. Move the edge again.`;
    case "pending_edit_changed":
      return "That edit changed while you were moving it. Check the new range and try again.";
    default:
      return `That edit's ${edge} was not saved, so it is back where it was. Move the edge again or pick a different range.`;
  }
}
