import { plural } from "../../utils/format";

export const NEEDS_ATTENTION = "Needs attention";
export const ATTENTION_DETAILS_LABEL = `${NEEDS_ATTENTION} details and recovery actions`;

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
