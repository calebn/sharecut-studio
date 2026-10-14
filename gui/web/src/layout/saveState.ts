import { SAVE_STATE_COPY } from "../record/saveStatus";

/** What a host can say about the last change, derived from the send and queue state. */
export type SaveState =
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "waiting"; count: number }
  | { kind: "failed"; cause: "refused"; reason: string }
  | { kind: "failed"; cause: "unreadable" };

export type SaveStateInput = {
  /** A save, send or replay is in flight in this tab. */
  busy: boolean;
  /** Edits in the offline queue, not yet applied. */
  pending: number;
  /** Reasons for the edits the server refused, newest last. */
  refusals: readonly string[];
  /** The saved edits on this device could not be read. */
  unreadable: boolean;
  /** A read of the queue has succeeded at least once. */
  loaded: boolean;
};

/**
 * Busy wins because an edit on its way is the freshest fact. Then an
 * unreadable queue, a refused edit, and edits waiting; the rest is saved. Null
 * until the queue has been read once, so a project never claims "Saved" before
 * it knows.
 */
export function saveStateOf(input: SaveStateInput): SaveState | null {
  if (input.busy) return { kind: "saving" };
  if (input.unreadable) return { kind: "failed", cause: "unreadable" };
  if (!input.loaded) return null;
  if (input.refusals.length > 0) {
    return {
      kind: "failed",
      cause: "refused",
      reason: input.refusals[input.refusals.length - 1],
    };
  }
  if (input.pending > 0) return { kind: "waiting", count: input.pending };
  return { kind: "saved" };
}

export const SAVE_PILL_COPY = {
  saving: SAVE_STATE_COPY.saving,
  saved: SAVE_STATE_COPY.saved,
  waiting: (count: number) => `Not saved yet · ${count} waiting to send`,
  waitingTitle: "Kept on this device until it sends. Press to send now.",
  refused: "Save failed · See why",
  unreadable: "Save failed · Retry",
  unreadableTitle:
    "Saved edits could not be read on this device. Press to try again.",
} as const;

/** The pill's visible line. */
export function saveStateText(state: SaveState): string {
  switch (state.kind) {
    case "saving":
      return SAVE_PILL_COPY.saving;
    case "saved":
      return SAVE_PILL_COPY.saved;
    case "waiting":
      return SAVE_PILL_COPY.waiting(state.count);
    case "failed":
      return state.cause === "refused"
        ? SAVE_PILL_COPY.refused
        : SAVE_PILL_COPY.unreadable;
  }
}

/**
 * What a screen reader hears when the state changes. Routine saving and saved
 * stay silent; a problem is spoken, and so is the recovery from one.
 */
export function saveStateAnnouncement(
  previous: SaveState | null,
  next: SaveState | null,
): string {
  if (!next || previous?.kind === next.kind) return "";
  if (next.kind === "waiting" || next.kind === "failed") {
    return saveStateText(next);
  }
  const troubled = previous?.kind === "waiting" || previous?.kind === "failed";
  return troubled && next.kind === "saved" ? SAVE_PILL_COPY.saved : "";
}
