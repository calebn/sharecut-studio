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
  /** A send ended and the queue has not been read since, so the counts are stale. */
  settling: boolean;
};

/**
 * Busy or settling wins because an edit on its way, or one whose outcome is not
 * yet read back, is the freshest fact. Then an unreadable queue, a refused
 * edit, and edits waiting; the rest is saved. Null until the queue has been
 * read once, so a project never claims "Saved" before it knows.
 */
export function saveStateOf(input: SaveStateInput): SaveState | null {
  if (input.busy || input.settling) return { kind: "saving" };
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

export const SAVE_DOT_COPY = {
  saving: SAVE_STATE_COPY.saving,
  saved: SAVE_STATE_COPY.saved,
  waiting: (count: number) => `Not saved yet · ${count} waiting to send`,
  failed: "Save failed",
} as const;

/** The dot's accessible name and tooltip. */
export function saveStateText(state: SaveState): string {
  switch (state.kind) {
    case "saving":
      return SAVE_DOT_COPY.saving;
    case "saved":
      return SAVE_DOT_COPY.saved;
    case "waiting":
      return SAVE_DOT_COPY.waiting(state.count);
    case "failed":
      return SAVE_DOT_COPY.failed;
  }
}
