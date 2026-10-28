import { useState } from "react";

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
  | "waiting"
  | "done"
  | "failed";

type AnnouncementInput = {
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
    case "waiting":
      return "Transcribing has not started. Run it when you are ready.";
    case "done":
      return `Done. ${handoffLabel}.`;
    case "failed":
      return failure
        ? `${failure.step} failed. Try again. ${failure.cause}`
        : "A step failed. Try again.";
  }
}

function phaseKey({ phase, failure }: AnnouncementInput): string {
  return phase === "failed" ? `failed:${failure?.step ?? ""}` : phase;
}

/**
 * The live region's text. It is composed once when the stage enters a phase
 * and kept until the next one, so a count that grows inside a phase ("Adding
 * 3 files" then 4) is not spoken again. A drag that is cancelled leaves the
 * phase as it was, so the region goes quiet instead of repeating it.
 */
export function useAnnouncement(input: AnnouncementInput): string {
  const key = phaseKey(input);
  const drop = Boolean(input.dropActive);
  const [spoken, setSpoken] = useState(() => ({
    key,
    drop,
    said: key,
    text: prepareAnnouncement(input),
  }));
  if (spoken.key === key && spoken.drop === drop) return spoken.text;
  const quiet = !drop && key === spoken.said;
  const text = quiet ? "" : prepareAnnouncement(input);
  setSpoken({ key, drop, said: drop ? spoken.said : key, text });
  return text;
}
