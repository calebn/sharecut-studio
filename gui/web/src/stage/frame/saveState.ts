import type { OfflineConflict } from "../../services/offlineQueue/offlineStore";

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
  | { kind: "failed"; cause: "unreadable" }
  | { kind: "failed"; cause: "project-unavailable"; reason: string };

type SaveStateInput = {
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
