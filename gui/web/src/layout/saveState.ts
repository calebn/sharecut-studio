import { SAVE_STATE_COPY } from "../record";
import type { OfflineConflict } from "../services/offlineQueue/offlineStore";

/** What a host can say about the last change, derived from the send and queue state. */
export type SaveState =
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "waiting"; count: number }
  | {
      kind: "unknown";
      reason: string;
      recovery: "retry-same-command" | "inspect-history";
    }
  | {
      kind: "failed";
      cause: "unreadable" | "project-unavailable";
      reason?: string;
    };

export type SaveStateInput = {
  /** A save, send or replay is in flight in this tab. */
  busy: boolean;
  /** Edits in the offline queue, not yet applied. */
  pending: number;
  /** Outcomes the Needs attention banner lists, newest last. */
  conflicts: readonly OfflineConflict[];
  /** The saved edits on this device could not be read. */
  unreadable: boolean;
  /** A read of the queue has succeeded at least once. */
  loaded: boolean;
  /** A send ended and the queue has not been read since, so the counts are stale. */
  settling: boolean;
};

/**
 * The newest outcome that says something about a save. A refused command wrote
 * nothing and lost no edit, so it stays in Needs attention but never turns the
 * light red.
 */
export function latestSaveOutcome(
  conflicts: readonly OfflineConflict[],
): OfflineConflict | undefined {
  return conflicts.findLast((conflict) => conflict.kind !== "refused");
}

/**
 * A refused command lost no edit, except when the project file itself is missing or
 * damaged: then nothing can be saved, so that refusal turns the light red until it is
 * dismissed or a later command saves.
 *
 * Busy or settling wins because an edit on its way, or one whose outcome is not
 * yet read back, is the freshest fact. Then an unreadable queue, an unknown
 * outcome, and edits waiting; the rest is saved. Null until the queue has been
 * read once, so a project never claims "Saved" before it knows.
 */
export function saveStateOf(input: SaveStateInput): SaveState | null {
  if (input.busy || input.settling) return { kind: "saving" };
  if (input.unreadable) return { kind: "failed", cause: "unreadable" };
  if (!input.loaded) return null;
  const blocked = input.conflicts.findLast(
    (c) => c.kind === "refused" && c.blocksSave === true && !c.dismissed,
  );
  if (blocked) {
    return {
      kind: "failed",
      cause: "project-unavailable",
      reason: blocked.reason,
    };
  }
  const latestOutcome = latestSaveOutcome(input.conflicts);
  if (latestOutcome?.kind === "unknown") {
    return {
      kind: "unknown",
      reason: latestOutcome.reason,
      recovery: latestOutcome.recovery,
    };
  }
  if (input.pending > 0) return { kind: "waiting", count: input.pending };
  return { kind: "saved" };
}

export const SAVE_DOT_COPY = {
  saving: SAVE_STATE_COPY.saving,
  saved: SAVE_STATE_COPY.saved,
  waiting: (count: number) => `Not saved yet · ${count} waiting to send`,
} as const;

/** The dot's accessible name and tooltip. */
export function saveStateText(state: SaveState): string {
  const reason = (value: string) => value.replace(/[.!?]+$/, "");
  switch (state.kind) {
    case "saving":
      return SAVE_DOT_COPY.saving;
    case "saved":
      return SAVE_DOT_COPY.saved;
    case "waiting":
      return SAVE_DOT_COPY.waiting(state.count);
    case "failed":
      return state.cause === "project-unavailable"
        ? `Not saved · ${reason(state.reason ?? "The project file is missing or damaged")}.`
        : "Saved edits could not be read · Retry to read them";
    case "unknown":
      return state.recovery === "inspect-history"
        ? `Outcome unknown · ${reason(state.reason)}. Inspect History before trying again.`
        : `Outcome unknown · ${reason(state.reason)}. Retry the same edit.`;
  }
}
