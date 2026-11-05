import type { OfflineConflict } from "../../services/offlineQueue/offlineStore";
import { plural } from "../../utils/format";

export const NEEDS_ATTENTION = "Needs attention";

export function attentionCountLabel(
  pending: number,
  conflictCount: number,
): string {
  return [
    pending > 0 ? `${pending} pending` : "",
    conflictCount > 0
      ? `${conflictCount} ${plural(conflictCount, "conflict")}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export function attentionRegionLabel(input: {
  pending: number;
  conflictCount: number;
  unreadable: boolean;
  dismissFailed: boolean;
}): string {
  const countLabel = attentionCountLabel(input.pending, input.conflictCount);
  return [
    NEEDS_ATTENTION,
    countLabel,
    input.unreadable ? "Saved edits could not be read" : "",
    input.dismissFailed ? "Dismissal failed" : "",
  ]
    .filter(Boolean)
    .join(". ");
}

export const UNREADABLE_NOTE =
  "Could not read saved edits on this device. Your saved edits have been kept.";
export const DISMISS_FAILED_NOTE =
  "Dismissal failed. Your saved outcomes have been kept.";

/** What a person can do about a conflict that no waiver settles. */
export function conflictAdvice(
  conflict: OfflineConflict,
  guest: boolean,
): string {
  if (conflict.kind === "refused")
    return conflict.blocksSave
      ? guest
        ? "Ask the project owner to check the project."
        : "Fix the project file first; this change was not saved."
      : "Edit the change and submit it again.";
  return conflict.recovery === "inspect-history"
    ? guest
      ? "Ask the project owner to inspect History before trying this action again."
      : "Inspect History before trying this action again."
    : "The app will retry this same command automatically.";
}
