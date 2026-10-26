/**
 * Where the stage is, in the words the live region needs. The region speaks
 * only when this changes, never on a progress tick.
 */
export type PreparePhase =
  | "empty"
  | "adding"
  | "checking"
  | "transcribing"
  | "needs-model"
  | "done"
  | "failed";

export type AnnouncementInput = {
  phase: PreparePhase;
  /** Files being added or just added. */
  addCount?: number;
  dropCount?: number;
  dropActive?: boolean;
  /** The hand-off label, spoken when everything is done. */
  handoffLabel: string;
  failure?: { step: string; cause: string };
};

function files(count: number | undefined): string {
  return count === undefined
    ? "files"
    : `${count} ${count === 1 ? "file" : "files"}`;
}

export function prepareAnnouncement({
  phase,
  addCount,
  dropCount,
  dropActive,
  handoffLabel,
  failure,
}: AnnouncementInput): string {
  if (dropActive) {
    return dropCount === undefined
      ? "Drop to add audio."
      : `Drop to add ${files(dropCount)}.`;
  }
  switch (phase) {
    case "empty":
      return "";
    case "adding":
      return `Adding ${files(addCount)}.`;
    case "checking":
      return addCount === undefined
        ? "Files added. Checking audio."
        : `${files(addCount)} added. Checking audio.`;
    case "transcribing":
      return "Transcribing started.";
    case "needs-model":
      return "Transcribing needs a download first. Other steps keep going.";
    case "done":
      return `Done. ${handoffLabel}.`;
    case "failed":
      return failure
        ? `${failure.step} failed. Try again. ${failure.cause}`
        : "A step failed. Try again.";
  }
}
