/** Plain-language names for a pending edit's type and reason code. */

const TYPE_LABELS: Record<string, string> = {
  remove: "Cut",
  mute: "Mute",
  split: "Split",
};

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

export function pendingTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
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
  const [head = "", ...rest] = reason.split(":");
  const tail = rest.join(":");
  if (head === "filler") {
    return tail === "acoustic" ? "Filler sound" : `Filler word "${tail}"`;
  }
  if (head === "pause" && tail) {
    return `Long pause (${tail})`;
  }
  if (head === "repetition") {
    return "Repeated word";
  }
  if (head === "restart") {
    return "False start";
  }
  return reason;
}
